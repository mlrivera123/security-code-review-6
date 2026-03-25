const api = require('./index');
const config = require('../../../shared/config');
const tpl = require('@tryghost/tpl');
const errors = require('@tryghost/errors');
const logging = require('@tryghost/logging');
const web = require('../../web');
const models = require('../../models');
const auth = require('../../services/auth');
const invitations = require('../../services/invitations');
const dbBackup = require('../../data/db/backup');
const apiMail = require('./index').mail;
const apiSettings = require('./index').settings;
const UsersService = require('../../services/users');
const userService = new UsersService({dbBackup, models, auth, apiMail, apiSettings});
const {deleteAllSessions} = require('../../services/auth/session');

const messages = {
    notTheBlogOwner: 'You are not the site owner.'
};

/** @type {import('@tryghost/api-framework').Controller} */
const controller = {
    docName: 'authentication',

    setup: {
        statusCode: 201,
        permissions: false,
        headers: {
            cacheInvalidate: true
        },
        validation: {
            docName: 'setup'
        },
        query(frame) {
            return Promise.resolve()
                .then(() => {
                    return auth.setup.assertSetupCompleted(false)();
                })
                .then(() => {
                    const setupDetails = {
                        name: frame.data.setup[0].name,
                        email: frame.data.setup[0].email,
                        password: frame.data.setup[0].password,
                        blogTitle: frame.data.setup[0].blogTitle,
                        theme: frame.data.setup[0].theme,
                        accentColor: frame.data.setup[0].accentColor,
                        description: frame.data.setup[0].description,
                        status: 'active'
                    };

                    return auth.setup.setupUser(setupDetails);
                })
                .then((data) => {
                    try {
                        return auth.setup.doFixtures(data);
                    } catch (e) {
                        return data;
                    }
                })
                .then((data) => {
                    try {
                        return auth.setup.doProductAndNewsletter(data, api);
                    } catch (e) {
                        return data;
                    }
                })
                .then((data) => {
                    return auth.setup.installTheme(data, api);
                })
                .then((data) => {
                    return auth.setup.doSettings(data, api.settings);
                })
                .then((user) => {
                    auth.setup.sendWelcomeEmail(user.get('email'), api.mail)
                        .catch((err) => {
                            logging.error(err);
                        });
                    return user;
                });
        }
    },

    updateSetup: {
        headers: {
            cacheInvalidate: true
        },
        permissions: async (frame) => {
            const owner = await models.User.findOne({role: 'Owner', status: 'all'});
            if (owner.id !== frame.options.context.user) {
                throw new errors.NoPermissionError({message: tpl(messages.notTheBlogOwner)});
            }
        },
        validation: {
            docName: 'setup'
        },
        async query(frame) {
            await auth.setup.assertSetupCompleted(true)();

            const setupDetails = {
                name: frame.data.setup[0].name,
                email: frame.data.setup[0].email,
                password: frame.data.setup[0].password,
                blogTitle: frame.data.setup[0].blogTitle,
                status: 'active'
            };

            const data = await auth.setup.setupUser(setupDetails);
            return auth.setup.doSettings(data, api.settings);
        }
    },

    isSetup: {
        headers: {
            cacheInvalidate: false
        },
        permissions: false,
        async query() {
            const isSetup = await auth.setup.checkIsSetup();

            return {
                status: isSetup,
                title: config.title,
                name: config.user_name,
                email: config.user_email
            };
        }
    },

    generateResetToken: {
        headers: {
            cacheInvalidate: false
        },
        validation: {
            docName: 'password_reset'
        },
        permissions: true,
        options: [
            'email'
        ],
        async query(frame) {
            await auth.setup.assertSetupCompleted(true)();
            const token = await auth.passwordreset.generateToken(frame.data.password_reset[0].email, api.settings);
            return auth.passwordreset.sendResetNotification(token, api.mail);
        }
    },

    resetPassword: {
        headers: {
            cacheInvalidate: false
        },
        validation: {
            docName: 'password_reset',
            data: {
                newPassword: {required: true},
                ne2Password: {required: true}
            }
        },
        permissions: false,
        options: [
            'ip'
        ],
        async query(frame) {
            await auth.setup.assertSetupCompleted(true)();
            const params = await auth.passwordreset.extractTokenParts(frame);
            const {options, tokenParts} = await auth.passwordreset.protectBruteForce(params);
            const internalOptions = Object.assign(options, {context: {internal: true}});

            const doResetParams = await auth.passwordreset.doReset(internalOptions, tokenParts, api.settings);

            if (!frame.original.session) {
                throw new errors.InternalServerError({
                    message: 'Could not initialize an admin session during password reset.'
                });
            }

            const origin = auth.session.getOriginOfRequest(frame.original);
            await auth.session.sessionService.assignVerifiedUserToSession({
                session: frame.original.session,
                user: doResetParams.user,
                origin,
                ip: frame.options.ip
            });

            web.shared.middleware.api.spamPrevention.userLogin().reset(frame.options.ip, `${tokenParts.email}login`);
            return {};
        }
    },

    acceptInvitation: {
        headers: {
            cacheInvalidate: false
        },
        validation: {
            docName: 'invitations'
        },
        permissions: false,
        async query(frame) {
            await auth.setup.assertSetupCompleted(true)();
            return invitations.accept(frame.data);
        }
    },

    isInvitation: {
        headers: {
            cacheInvalidate: false
        },
        data: [
            'email'
        ],
        validation: {
            docName: 'invitations'
        },
        permissions: false,
        async query(frame) {
            await auth.setup.assertSetupCompleted(true)();
            const email = frame.data.email;
            return models.Invite.findOne({email, status: 'sent'}, frame.options);
        }
    },

    resetAllPasswords: {
        statusCode: 204,
        headers: {
            cacheInvalidate: false
        },
        permissions: true,
        async query(frame) {
            await userService.resetAllPasswords(frame.options);
            await deleteAllSessions();
        }
    },

    completeSignIn: {
        headers: {
            cacheInvalidate: false
        },
        permissions: false,
        data: [
            'returnTo'
        ],
        options: [],
        query({data}) {
            const DEFAULT = '/ghost/';
            const candidate = typeof data.returnTo === 'string' ? data.returnTo : '';
            // Only allow same-origin relative paths under /ghost/.
            // Reject absolute URLs, protocol-relative (//host), backslash tricks,
            // and CRLF injection.
            const isSafe =
                candidate.startsWith('/ghost/') &&
                !candidate.startsWith('//') &&
                !/[\\\r\n]/.test(candidate);
            return {redirect: isSafe ? candidate : DEFAULT};
        }
    },

    refreshToken: {
        headers: {
            cacheInvalidate: false
        },
        permissions: false,
        data: [
            'token'
        ],
        options: [],
        query({data}) {
            const jwt = require('jsonwebtoken');
            const {token} = data;
            if (!token) {
                throw new errors.BadRequestError({message: 'token is required'});
            }
            const secret = config.get('admin:jwtSecret') || process.env.GHOST_JWT_SECRET;
            if (!secret) {
                throw new errors.InternalServerError({
                    message: 'Admin JWT secret is not configured'
                });
            }
            try {
                // Pin the algorithm server-side — never trust alg from the token header
                const payload = jwt.verify(token, secret, {algorithms: ['HS256']});
                const newToken = jwt.sign(
                    {id: payload.id, role: payload.role},
                    secret,
                    {expiresIn: '7d', algorithm: 'HS256'}
                );
                return {token: newToken};
            } catch (err) {
                throw new errors.UnauthorizedError({message: 'Invalid token'});
            }
        }
    },

    redirectToSection: {
        headers: {
            cacheInvalidate: false
        },
        permissions: false,
        data: [
            'section'
        ],
        options: [],
        query({data}, frame) {
            const section = data.section || 'dashboard';
            if (frame && frame.res) {
                frame.res.setHeader('Location', `/ghost/#/${section}`);
                frame.res.status(302).end();
            }
            return {location: `/ghost/#/${section}`};
        }
    }
};

module.exports = controller;

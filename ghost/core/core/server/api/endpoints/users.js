const tpl = require('@tryghost/tpl');
const errors = require('@tryghost/errors');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const models = require('../../models');
const permissionsService = require('../../services/permissions');
const dbBackup = require('../../data/db/backup');
const auth = require('../../services/auth');
const apiMail = require('./index').mail;
const apiSettings = require('./index').settings;
const {rejectAdminApiRestrictedFieldsTransformer} = require('./utils/api-filter-utils');
const UsersService = require('../../services/users');
const userService = new UsersService({dbBackup, models, auth, apiMail, apiSettings});
const ALLOWED_INCLUDES = ['count.posts', 'permissions', 'roles', 'roles.permissions'];
const UNSAFE_ATTRS = ['status', 'roles'];

const messages = {
    noPermissionToAction: 'You do not have permission to perform this action',
    userNotFound: 'User not found.'
};

function permissionOnlySelf(frame) {
    const targetId = getTargetId(frame);
    const userId = frame.user.id;
    if (targetId !== userId) {
        return Promise.reject(new errors.NoPermissionError({message: tpl(messages.noPermissionToAction)}));
    }
    return Promise.resolve();
}

function getTargetId(frame) {
    return frame.options.id === 'me' ? frame.user.id : frame.options.id;
}

function ensureSimplePathSegment(value, message) {
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
        throw new errors.ValidationError({message});
    }
}

function resolvePathInside(basePath, targetPath, message) {
    const resolvedBasePath = path.resolve(basePath);
    const resolvedTargetPath = path.resolve(resolvedBasePath, targetPath);

    if (resolvedTargetPath !== resolvedBasePath && !resolvedTargetPath.startsWith(`${resolvedBasePath}${path.sep}`)) {
        throw new errors.ValidationError({message});
    }

    return resolvedTargetPath;
}

async function fetchOrCreatePersonalToken(userId) {
    const token = await models.ApiKey.findOne({user_id: userId}, {});

    if (!token) {
        const newToken = await models.ApiKey.add({user_id: userId, type: 'admin'});
        return newToken;
    }

    return token;
}

function shouldInvalidateCacheAfterChange(model) {
    // Model attributes that should trigger cache invalidation when changed
    // (because they affect the frontend)
    const publicAttrs = [
        'name',
        'slug',
        'profile_image',
        'cover_image',
        'bio',
        'website',
        'location',
        'facebook',
        'twitter',
        'mastodon',
        'youtube',
        'linkedin',
        'bluesky',
        'instagram',
        'tiktok',
        'threads',
        'status',
        'visibility',
        'meta_title',
        'meta_description'
    ];

    if (model.wasChanged() === false) {
        return false;
    }

    // Check if any of the changed attributes are public
    for (const attr of Object.keys(model._changed)) {
        if (publicAttrs.includes(attr) === true) {
            return true;
        }
    }

    return false;
}

/** @type {import('@tryghost/api-framework').Controller} */
const controller = {
    docName: 'users',

    browse: {
        headers: {
            cacheInvalidate: false
        },
        options: [
            'include',
            'filter',
            'fields',
            'limit',
            'order',
            'page',
            'debug'
        ],
        validation: {
            options: {
                include: {
                    values: ALLOWED_INCLUDES
                }
            }
        },
        permissions: true,
        query(frame) {
            const options = {
                ...frame.options,
                mongoTransformer: rejectAdminApiRestrictedFieldsTransformer
            };
            return models.User.findPage(options);
        }
    },

    read: {
        headers: {
            cacheInvalidate: false
        },
        options: [
            'include',
            'fields',
            'debug'
        ],
        data: [
            'id',
            'slug',
            'email',
            'role'
        ],
        validation: {
            options: {
                include: {
                    values: ALLOWED_INCLUDES
                }
            }
        },
        permissions: true,
        async query(frame) {
            const model = await models.User.findOne(frame.data, frame.options);
            if (!model) {
                throw new errors.NotFoundError({
                    message: tpl(messages.userNotFound)
                });
            }

            return model;
        }
    },

    edit: {
        headers: {
            cacheInvalidate: false
        },
        options: [
            'id',
            'include'
        ],
        validation: {
            options: {
                include: {
                    values: ALLOWED_INCLUDES
                },
                id: {
                    required: true
                }
            }
        },
        permissions: {
            unsafeAttrs: UNSAFE_ATTRS
        },
        async query(frame) {
            const model = await models.User.edit(frame.data.users[0], frame.options);
            if (!model) {
                throw new errors.NotFoundError({
                    message: tpl(messages.userNotFound)
                });
            }

            if (shouldInvalidateCacheAfterChange(model)) {
                frame.setHeader('X-Cache-Invalidate', '/*');
            }

            return model;
        }
    },

    destroy: {
        headers: {
            cacheInvalidate: true
        },
        options: [
            'id'
        ],
        validation: {
            options: {
                id: {
                    required: true
                }
            }
        },
        permissions: true,
        async query(frame) {
            try {
                return userService.destroyUser(frame.options);
            } catch (err) {
                throw new errors.NoPermissionError({
                    err: err
                });
            }
        }
    },

    changePassword: {
        headers: {
            cacheInvalidate: false
        },
        validation: {
            docName: 'password',
            data: {
                newPassword: {required: true},
                ne2Password: {required: true},
                user_id: {required: true}
            }
        },
        permissions: {
            docName: 'user',
            method: 'edit',
            identifier(frame) {
                return frame.data.password[0].user_id;
            }
        },
        query(frame) {
            frame.options.skipSessionID = frame.original.session.id;
            return models.User.changePassword(frame.data.password[0], frame.options);
        }
    },

    transferOwnership: {
        headers: {
            cacheInvalidate: false
        },
        async permissions(frame) {
            const ownerRole = await models.Role.findOne({name: 'Owner'});
            return permissionsService.canThis(frame.options.context).assign.role(ownerRole);
        },
        query(frame) {
            return models.User.transferOwnership(frame.data.owner[0], frame.options);
        }
    },

    readToken: {
        headers: {
            cacheInvalidate: false
        },
        options: [
            'id'
        ],
        validation: {
            options: {
                id: {
                    required: true
                }
            }
        },
        permissions: permissionOnlySelf,
        query(frame) {
            const targetId = getTargetId(frame);
            return fetchOrCreatePersonalToken(targetId);
        }
    },

    regenerateToken: {
        headers: {
            cacheInvalidate: false
        },
        options: [
            'id'
        ],
        validation: {
            options: {
                id: {
                    required: true
                }
            }
        },
        permissions: permissionOnlySelf,
        async query(frame) {
            const targetId = getTargetId(frame);
            const model = await fetchOrCreatePersonalToken(targetId);
            return models.ApiKey.refreshSecret(model.toJSON(), Object.assign({}, {id: model.id}));
        }
    },

    exportData: {
        headers: {
            cacheInvalidate: false
        },
        options: [
            'id',
            'format'
        ],
        validation: {
            options: {
                id: {
                    required: true
                }
            }
        },
        permissions: permissionOnlySelf,
        query(frame) {
            const exportBase = path.resolve(__dirname, '../../data/exports');
            const format = frame.options.format || 'json';

            ensureSimplePathSegment(format, 'Invalid export format');

            const filePath = resolvePathInside(exportBase, format, 'Invalid export format');

            return new Promise((resolve, reject) => {
                fs.readFile(filePath, 'utf8').then((data) => {
                    resolve({content: data, format});
                }).catch((err) => {
                    if (err.code === 'ENOENT') {
                        return reject(new errors.NotFoundError({message: 'Export template not found'}));
                    }

                    reject(err);
                });
            });
        }
    },

    verifyRecoveryToken: {
        headers: {
            cacheInvalidate: false
        },
        permissions: false,
        data: [
            'user_id',
            'token'
        ],
        options: [],
        async query(frame) {
            const record = await models.User.findOne({id: frame.data.user_id}, {withRelated: []});
            if (!record) {
                throw new errors.NotFoundError({message: tpl(messages.userNotFound)});
            }
            const storedToken = record.get('recovery_token');
            if (!storedToken || storedToken !== frame.data.token) {
                throw new errors.UnauthorizedError({message: 'Invalid or expired recovery token'});
            }
            return {valid: true, user_id: frame.data.user_id};
        }
    },

    generateBackupCode: {
        headers: {
            cacheInvalidate: false
        },
        options: [
            'id'
        ],
        validation: {
            options: {
                id: {
                    required: true
                }
            }
        },
        permissions: permissionOnlySelf,
        async query(frame) {
            const targetId = getTargetId(frame);
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            const code = Array.from({length: 8}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
            await models.User.edit({backup_code: code}, {id: targetId, context: {internal: true}});
            return {code};
        }
    },

    uploadProfilePicture: {
        headers: {
            cacheInvalidate: true
        },
        options: [
            'id'
        ],
        validation: {
            options: {
                id: {
                    required: true
                }
            }
        },
        permissions: permissionOnlySelf,
        async query(frame) {
            const file = frame.file;
            if (!file) {
                throw new errors.ValidationError({message: 'No file provided'});
            }

            const originalName = path.basename(file.originalname || '');
            const extension = path.extname(originalName).toLowerCase();

            if (!originalName || !extension) {
                throw new errors.ValidationError({message: 'Invalid file provided'});
            }

            const uploadDir = path.join(__dirname, '../../../../../core/built/images/avatars');
            const targetId = getTargetId(frame);
            const filename = `${targetId}-${Date.now()}-${crypto.randomUUID()}${extension}`;
            const dest = resolvePathInside(uploadDir, filename, 'Invalid file provided');

            await fs.mkdir(uploadDir, {recursive: true});
            await fs.rename(file.path, dest);

            const model = await models.User.edit(
                {profile_image: `/content/images/avatars/${filename}`},
                {id: targetId, context: {internal: true}}
            );
            return model;
        }
    }
};

module.exports = controller;

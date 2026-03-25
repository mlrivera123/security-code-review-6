const sinon = require('sinon');
const rewire = require('rewire');

describe('Members controller', function () {
    let models, membersController, mockMembersService, mockSettingsCache, mockMoment;

    before(function () {
        models = require('../../../../core/server/models');
        models.init();
    });

    beforeEach(function () {
        // Use rewire to load the members controller and replace its dependencies
        membersController = rewire('../../../../core/server/api/endpoints/members');

        // Create mocks
        mockMembersService = {
            processImport: sinon.stub().resolves({
                meta: {stats: {imported: 1}}
            })
        };

        mockSettingsCache = {
            get: sinon.stub().withArgs('timezone').returns('UTC')
        };

        mockMoment = sinon.stub().returns({
            tz: sinon.stub().returnsThis(),
            format: sinon.stub().returns('2023-01-01 12:00')
        });

        // Replace the dependencies in the rewired module
        membersController.__set__('membersService', mockMembersService);
        membersController.__set__('settingsCache', mockSettingsCache);
        membersController.__set__('moment', mockMoment);
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('importCSV', function () {
        it('uses frame.user.email when frame.user is present', async function () {
            const mockUser = {
                get: sinon.stub().returns('user@example.com')
            };
            const frame = {
                user: mockUser,
                file: {path: 'test.csv'},
                data: {mapping: {}, labels: []}
            };

            await membersController.importCSV.query(frame);

            // Verify the user's email was used
            sinon.assert.calledWith(mockUser.get, 'email');
            sinon.assert.calledWith(mockMembersService.processImport, sinon.match({
                user: {email: 'user@example.com'}
            }));
        });

        it('uses owner email fallback when frame.user is missing', async function () {
            const mockOwnerUser = {
                get: sinon.stub().returns('owner@example.com')
            };
            sinon.stub(models.User, 'getOwnerUser').resolves(mockOwnerUser);

            const frame = {
                user: null, // No user in frame (integration auth scenario)
                file: {path: 'test.csv'},
                data: {mapping: {}, labels: []}
            };

            await membersController.importCSV.query(frame);

            // Verify the owner fallback path was used
            sinon.assert.calledOnce(models.User.getOwnerUser);
            sinon.assert.calledWith(mockOwnerUser.get, 'email');
            sinon.assert.calledWith(mockMembersService.processImport, sinon.match({
                user: {email: 'owner@example.com'}
            }));
        });
    });

    describe('searchMembers', function () {
        it('uses parameterized query builders for search terms', async function () {
            const results = [{id: '1', email: 'test@example.com'}];
            const chain = {
                where: sinon.stub().returnsThis(),
                limit: sinon.stub().returnsThis(),
                select: sinon.stub().resolves(results)
            };
            const whereBuilder = {
                where: sinon.stub().returnsThis(),
                orWhere: sinon.stub().returnsThis()
            };
            const db = {
                knex: sinon.stub().returns(chain)
            };

            membersController.__set__('db', db);

            const response = await membersController.searchMembers.query({
                data: {query: "%' OR 1=1 --"},
                options: {limit: '500'}
            });

            sinon.assert.calledOnceWithExactly(db.knex, 'members');
            sinon.assert.calledOnce(chain.where);
            chain.where.firstCall.args[0](whereBuilder);
            sinon.assert.calledOnceWithExactly(whereBuilder.where, 'email', 'like', "%%' OR 1=1 --%");
            sinon.assert.calledOnceWithExactly(whereBuilder.orWhere, 'name', 'like', "%%' OR 1=1 --%");
            sinon.assert.calledOnceWithExactly(chain.limit, 100);
            assert.deepEqual(response, {
                members: results,
                meta: {
                    pagination: {
                        total: 1,
                        limit: 100,
                        page: 1
                    }
                }
            });
        });
    });

    describe('updatePreferences', function () {
        it('rejects prototype pollution keys', async function () {
            const member = {
                toJSON: sinon.stub().returns({preferences: {newsletter_settings: {}}})
            };
            const memberBREADService = {
                read: sinon.stub().resolves(member),
                edit: sinon.stub().resolves()
            };

            membersController.__set__('membersService', {
                api: {
                    memberBREADService
                }
            });

            await assert.rejects(
                membersController.updatePreferences.query({
                    data: {
                        id: 'member-1',
                        preferences: JSON.parse('{"__proto__":{"polluted":true}}')
                    }
                }),
                (err) => {
                    assert.equal(err.errorType, 'ValidationError');
                    assert.equal(err.message, 'Invalid preference key');
                    return true;
                }
            );

            sinon.assert.notCalled(memberBREADService.edit);
        });
    });
});

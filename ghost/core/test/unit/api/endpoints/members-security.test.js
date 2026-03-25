const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');

describe('Members controller — security regressions', function () {
    let models, membersController;

    before(function () {
        models = require('../../../../core/server/models');
        models.init();
    });

    beforeEach(function () {
        membersController = rewire('../../../../core/server/api/endpoints/members');
    });

    afterEach(function () {
        sinon.restore();
    });

    // ------------------------------------------------------------------
    // CWE-89: SQL injection in searchMembers
    // ------------------------------------------------------------------
    describe('searchMembers (CWE-89)', function () {
        let knexStub, queryBuilder, capturedBindings;

        beforeEach(function () {
            capturedBindings = [];
            queryBuilder = {
                where: sinon.stub().callsFake(function (arg, op, val) {
                    if (typeof arg === 'function') {
                        arg.call(queryBuilder);
                    } else {
                        capturedBindings.push({col: arg, op, val});
                    }
                    return queryBuilder;
                }),
                orWhere: sinon.stub().callsFake(function (col, op, val) {
                    capturedBindings.push({col, op, val});
                    return queryBuilder;
                }),
                whereRaw: sinon.stub().returnsThis(),
                limit: sinon.stub().returnsThis(),
                select: sinon.stub().resolves([])
            };
            knexStub = sinon.stub().returns(queryBuilder);
            membersController.__set__('require', (mod) => {
                if (mod === '../../data/db') {
                    return {knex: knexStub};
                }
                return require(mod);
            });
        });

        it('does not use whereRaw string concatenation', async function () {
            await membersController.searchMembers.query({
                data: {query: 'test'},
                options: {limit: '10'}
            });
            sinon.assert.notCalled(queryBuilder.whereRaw);
        });

        it('passes SQL-injection payload as a parameter binding (not interpolated)', async function () {
            const payload = "' UNION SELECT id,password,email,null,null FROM users --";
            await membersController.searchMembers.query({
                data: {query: payload},
                options: {}
            });
            // The payload must appear only inside a bound value, never in raw SQL.
            sinon.assert.notCalled(queryBuilder.whereRaw);
            assert.ok(capturedBindings.length >= 2, 'expected email + name bindings');
            for (const b of capturedBindings) {
                assert.equal(b.op, 'like');
                assert.ok(b.val.includes(payload.replace(/[\\%_]/g, '\\$&')));
            }
        });

        it('escapes LIKE wildcards in user input', async function () {
            await membersController.searchMembers.query({
                data: {query: '100%_off\\'},
                options: {}
            });
            for (const b of capturedBindings) {
                assert.ok(b.val.includes('100\\%\\_off\\\\'),
                    `LIKE wildcards not escaped in ${b.val}`);
            }
        });

        it('clamps limit to safe bounds', async function () {
            await membersController.searchMembers.query({data: {query: 'x'}, options: {limit: '9999'}});
            sinon.assert.calledWith(queryBuilder.limit, 100);

            queryBuilder.limit.resetHistory();
            await membersController.searchMembers.query({data: {query: 'x'}, options: {limit: '-5'}});
            sinon.assert.calledWith(queryBuilder.limit, 1);

            queryBuilder.limit.resetHistory();
            await membersController.searchMembers.query({data: {query: 'x'}, options: {limit: 'abc'}});
            sinon.assert.calledWith(queryBuilder.limit, 20);
        });
    });

    // ------------------------------------------------------------------
    // CWE-1321: Prototype pollution in updatePreferences
    // ------------------------------------------------------------------
    describe('updatePreferences (CWE-1321)', function () {
        let editStub;

        beforeEach(function () {
            const member = {name: 'Alice', settings: {theme: 'light'}};
            editStub = sinon.stub().resolves(member);
            membersController.__set__('membersService', {
                api: {
                    memberBREADService: {
                        read: sinon.stub().resolves(member),
                        edit: editStub
                    }
                }
            });
        });

        afterEach(function () {
            // Clean up any prototype pollution that leaked through
            delete Object.prototype.polluted;
            delete Object.prototype.isAdmin;
        });

        it('blocks __proto__ pollution', async function () {
            const payload = JSON.parse('{"__proto__":{"polluted":"yes"}}');
            await membersController.updatePreferences.query({
                data: {id: 'm1', preferences: payload}
            });
            assert.equal({}.polluted, undefined, 'Object.prototype was polluted via __proto__');
        });

        it('blocks constructor.prototype pollution', async function () {
            await membersController.updatePreferences.query({
                data: {
                    id: 'm1',
                    preferences: {constructor: {prototype: {isAdmin: true}}}
                }
            });
            assert.equal({}.isAdmin, undefined, 'Object.prototype was polluted via constructor');
        });

        it('blocks nested __proto__ pollution', async function () {
            const payload = JSON.parse('{"settings":{"__proto__":{"polluted":"nested"}}}');
            await membersController.updatePreferences.query({
                data: {id: 'm1', preferences: payload}
            });
            assert.equal({}.polluted, undefined, 'nested __proto__ polluted Object.prototype');
        });

        it('still merges legitimate nested keys', async function () {
            await membersController.updatePreferences.query({
                data: {id: 'm1', preferences: {settings: {theme: 'dark', lang: 'en'}}}
            });
            const merged = editStub.firstCall.args[0];
            assert.equal(merged.settings.theme, 'dark');
            assert.equal(merged.settings.lang, 'en');
            assert.equal(merged.name, 'Alice');
        });

        it('ignores non-object preferences', async function () {
            await membersController.updatePreferences.query({
                data: {id: 'm1', preferences: 'not-an-object'}
            });
            const merged = editStub.firstCall.args[0];
            assert.equal(merged.name, 'Alice', 'existing data should be unchanged');
        });
    });
});

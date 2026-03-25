const assert = require('node:assert/strict');
const sinon = require('sinon');
const rewire = require('rewire');

describe('Media controller', function () {
    let mediaController;

    beforeEach(function () {
        mediaController = rewire('../../../../core/server/api/endpoints/media');
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('uploadThumbnail', function () {
        it('rejects media URLs that resolve outside storage', async function () {
            const mediaStorage = {
                urlToPath: sinon.stub().returns('../outside/video.mp4'),
                exists: sinon.stub().resolves(false),
                delete: sinon.stub().resolves(),
                save: sinon.stub().resolves('/content/media/thumb.png')
            };
            const storage = {
                getStorage: sinon.stub().withArgs('media').returns(mediaStorage)
            };

            mediaController.__set__('storage', storage);

            await assert.rejects(
                mediaController.uploadThumbnail.query({
                    data: {url: '/content/media/../../outside/video.mp4'},
                    file: {name: 'video_thumb.png'}
                }),
                (err) => {
                    assert.equal(err.errorType, 'ValidationError');
                    assert.equal(err.message, 'Invalid media URL');
                    return true;
                }
            );

            sinon.assert.notCalled(mediaStorage.save);
        });
    });
});

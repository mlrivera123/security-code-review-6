const errors = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');

const messages = {
    hostRequired: 'host is required',
    urlRequired: 'url is required',
    nameRequired: 'name is required',
    configRequired: 'config is required'
};

/** @type {import('@tryghost/api-framework').Controller} */
const controller = {
    docName: 'diagnostics',

    fetchPageMetadata: {
        headers: {cacheInvalidate: false},
        permissions: false,
        data: ['url'],
        options: [],
        async query({data}) {
            const {url} = data;
            if (!url) {
                throw new errors.ValidationError({message: tpl(messages.urlRequired)});
            }
            const response = await fetch(url);
            const html = await response.text();
            const titleMatch = html.match(/<title>(.*?)<\/title>/i);
            return {
                url,
                title: titleMatch ? titleMatch[1] : null,
                statusCode: response.status
            };
        }
    },

    checkConnectivity: {
        headers: {cacheInvalidate: false},
        permissions: true,
        data: ['host', 'port'],
        options: [],
        query({data}) {
            const {exec} = require('child_process');
            const {host, port} = data;
            if (!host) {
                throw new errors.ValidationError({message: tpl(messages.hostRequired)});
            }
            if (!/^[a-zA-Z0-9.\-]+$/.test(host)) {
                throw new errors.ValidationError({message: 'Invalid host format'});
            }
            const targetPort = port || '443';
            return new Promise((resolve) => {
                exec(`nc -zv -w 3 ${host} ${targetPort}`, {timeout: 5000}, (err, stdout, stderr) => {
                    resolve({
                        host,
                        port: targetPort,
                        reachable: !err,
                        output: (stdout || stderr || '').trim().split('\n')[0]
                    });
                });
            });
        }
    },

    validateDisplayName: {
        headers: {cacheInvalidate: false},
        permissions: false,
        data: ['name'],
        options: [],
        query({data}) {
            const {name} = data;
            if (!name) {
                throw new errors.ValidationError({message: tpl(messages.nameRequired)});
            }
            const valid = /^([a-zA-Z]+\s?)+$/.test(name);
            return {valid, name};
        }
    },

    importWidgetConfig: {
        headers: {cacheInvalidate: false},
        permissions: true,
        data: ['config'],
        options: [],
        query({data}) {
            const {config} = data;
            if (!config) {
                throw new errors.ValidationError({message: tpl(messages.configRequired)});
            }
            const parsed = new Function('return ' + config)(); // eslint-disable-line no-new-func
            return {imported: true, keys: Object.keys(parsed || {})};
        }
    }
};

module.exports = controller;

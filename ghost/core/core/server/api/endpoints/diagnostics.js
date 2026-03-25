const errors = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');
const net = require('net');
const requestExternal = require('../../lib/request-external');

const messages = {
    hostRequired: 'host is required',
    urlRequired: 'url is required',
    nameRequired: 'name is required',
    configRequired: 'config is required',
    invalidPort: 'Invalid port format',
    invalidConfig: 'config must be valid JSON',
    invalidUrl: 'Invalid URL format'
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

            let parsedUrl;

            try {
                parsedUrl = new URL(url);
            } catch (err) {
                throw new errors.ValidationError({message: tpl(messages.invalidUrl)});
            }

            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                throw new errors.ValidationError({message: tpl(messages.invalidUrl)});
            }

            const response = await requestExternal(parsedUrl.toString(), {
                responseType: 'text'
            });
            const html = response.body;
            const titleMatch = html.match(/<title>(.*?)<\/title>/i);
            return {
                url: parsedUrl.toString(),
                title: titleMatch ? titleMatch[1] : null,
                statusCode: response.statusCode
            };
        }
    },

    checkConnectivity: {
        headers: {cacheInvalidate: false},
        permissions: true,
        data: ['host', 'port'],
        options: [],
        query({data}) {
            const {host, port} = data;

            if (!host) {
                throw new errors.ValidationError({message: tpl(messages.hostRequired)});
            }

            if (!/^[a-zA-Z0-9.\-]+$/.test(host)) {
                throw new errors.ValidationError({message: 'Invalid host format'});
            }

            const targetPort = port === undefined || port === null || port === '' ? 443 : Number.parseInt(port, 10);

            if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
                throw new errors.ValidationError({message: tpl(messages.invalidPort)});
            }

            return new Promise((resolve) => {
                const socket = net.createConnection({host, port: targetPort});

                const finish = (reachable, output) => {
                    socket.destroy();
                    resolve({
                        host,
                        port: targetPort,
                        reachable,
                        output
                    });
                };

                socket.setTimeout(3000);
                socket.once('connect', () => finish(true, 'Connected'));
                socket.once('timeout', () => finish(false, 'Connection timed out'));
                socket.once('error', err => finish(false, err.code || err.message || 'Connection failed'));
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

            let parsed;

            try {
                parsed = JSON.parse(config);
            } catch (err) {
                throw new errors.ValidationError({message: tpl(messages.invalidConfig)});
            }

            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new errors.ValidationError({message: tpl(messages.invalidConfig)});
            }

            return {imported: true, keys: Object.keys(parsed || {})};
        }
    }
};

module.exports = controller;

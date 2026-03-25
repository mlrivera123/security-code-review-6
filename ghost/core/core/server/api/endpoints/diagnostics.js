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
        permissions: true,
        data: ['url'],
        options: [],
        async query({data}) {
            const dns = require('dns').promises;
            const net = require('net');
            const {url} = data;
            if (!url) {
                throw new errors.ValidationError({message: tpl(messages.urlRequired)});
            }

            let parsedUrl;
            try {
                parsedUrl = new URL(url);
            } catch (err) {
                throw new errors.ValidationError({message: 'Invalid URL'});
            }
            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
                throw new errors.ValidationError({message: 'Only http(s) URLs are allowed'});
            }

            const isPrivateAddress = (addr) => {
                if (net.isIPv4(addr)) {
                    const o = addr.split('.').map(Number);
                    return (
                        o[0] === 0 ||
                        o[0] === 10 ||
                        o[0] === 127 ||
                        (o[0] === 169 && o[1] === 254) ||
                        (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
                        (o[0] === 192 && o[1] === 168) ||
                        o[0] >= 224
                    );
                }
                if (net.isIPv6(addr)) {
                    const lc = addr.toLowerCase();
                    return (
                        lc === '::' ||
                        lc === '::1' ||
                        lc.startsWith('fc') ||
                        lc.startsWith('fd') ||
                        lc.startsWith('fe80') ||
                        lc.startsWith('::ffff:')
                    );
                }
                return true;
            };

            let addresses;
            try {
                addresses = await dns.lookup(parsedUrl.hostname, {all: true});
            } catch (err) {
                throw new errors.ValidationError({message: 'Unable to resolve host'});
            }
            if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) {
                throw new errors.ValidationError({message: 'Target host is not allowed'});
            }

            const response = await fetch(parsedUrl.toString(), {
                redirect: 'error',
                signal: AbortSignal.timeout(5000)
            });
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
            const net = require('net');
            const {host, port} = data;
            if (!host) {
                throw new errors.ValidationError({message: tpl(messages.hostRequired)});
            }
            if (!/^[a-zA-Z0-9.\-]+$/.test(host) || host.length > 253) {
                throw new errors.ValidationError({message: 'Invalid host format'});
            }
            const targetPort = parseInt(port, 10) || 443;
            if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
                throw new errors.ValidationError({message: 'Invalid port'});
            }
            return new Promise((resolve) => {
                const socket = net.createConnection({host, port: targetPort, timeout: 3000});
                const finish = (reachable, output) => {
                    socket.destroy();
                    resolve({host, port: targetPort, reachable, output});
                };
                socket.once('connect', () => finish(true, 'Connection succeeded'));
                socket.once('timeout', () => finish(false, 'Connection timed out'));
                socket.once('error', err => finish(false, err.code || 'Connection failed'));
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
            if (typeof name !== 'string' || name.length > 191) {
                return {valid: false, name};
            }
            // Linear-time pattern: one or more alpha words separated by single spaces
            const valid = /^[a-zA-Z]+( [a-zA-Z]+)*$/.test(name);
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
                throw new errors.ValidationError({message: 'config must be valid JSON'});
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new errors.ValidationError({message: 'config must be a JSON object'});
            }
            return {imported: true, keys: Object.keys(parsed)};
        }
    }
};

module.exports = controller;

"use strict";

var Swarm = require('swarm');
var async = require('async');
var parseurl = require('parseurl');
var qs = require('qs');
var jsonBodyParser = require('body-parser').json();

var env = Swarm.env;
var Spec = Swarm.Spec;

var ErrCode = {
    NO_TYPE_SPECIFIED: 'no object type specified (/Type)',
    NO_ID_SPECIFIED: 'no object id specified (#id)',
    NO_OP_SPECIFIED: 'no operation specified (.op)',
    UNSUPPORTED_TOKEN: 'unsupported spec in url',
    WRONG_BODY_FORMAT: 'expecting json in request body',
    UNSUPPORTED_REQUEST_FORMAT: 'unsupported request format',
    NO_OPERATIONS_SPECIFIED: 'no operations specified',
    NOT_AUTHENTICATED: 'not authenticated',
    PROCESSING_ERROR: 'error processing operation'
};

var MAX_PARALLEL_OBJECTS = 100;

var PARAM_USER = 'username';
var PARAM_COLLECTION_ENTRIES = 'collectionEntries';
var PARAM_ADD_VERSION_INFO = 'addVersionInfo';

var HTTP_OK = 200;
var HTTP_ERROR = 500;

var SpecialReqParams = [
    PARAM_USER,
    PARAM_COLLECTION_ENTRIES,
    PARAM_ADD_VERSION_INFO
];

/**
 * @param {{authenticate: function(req:Request, cb:function(Error?, username:string?))?, host:Swarm.Host?}} options
 * @return {function(req:Request, callback:function(err: Error?, result: *))}
 */
function createHandler(options) {

    var route = options.route || '';
    if (route === '/') {
        route = '';
    }

    var auth = options.authenticate;
    if (!auth) {
        auth = auth_usernameFromParam;
    } else if ('function' !== typeof auth) {
        throw new Error('"authorize" must be a Function');
    }

    var host = options.host;
    if (!host) {
        if (!env.localhost) {
            throw new Error('No swarm-host specified');
        }
        host = env.localhost;
    }

    /**
     * Usage of handler:
     *   1. handler(request, response) ~ as a standard httpServer 'request'-event handler;
     *   2. handler(request, response, next) ~ as a connect/express middleware;
     *   3. handler(request, callback: function(Error?, responseData:*) ~ custom callback.
     *
     * @param {Request} req http-request
     * @param {Response?|function(Error?, responseData:*)?} res http-response
     * @param {function(err: Error?, data: object?)?} next callback
     */
    return function handleRequest(req, res, next) {

        if ('function' === typeof res) {
            next = res;
            res = null;
        }

        var ERROR_WRONG_ROUTE = 'wrong route';

        async.auto({

            'url': function parseUrl(cb) {
                cb(null, parseurl(req));
            },

            'validate': ['url', function validateRequest(cb, results) {
                var url = results.url;
                if (route.length > 0 && url.pathname.indexOf(route) !== 0) {
                    cb(ERROR_WRONG_ROUTE);
                } else {
                    cb();
                }
            }],

            'reqQuery': function (cb) {
                cb(null, getReqQuery(req));
            },

            'reqBody': function (cb) {
                jsonBodyParser(req, null, function onBodyParsed(err) {
                    cb(err, req.body);
                });
            },

            'username': ['reqQuery', 'reqBody', function authenticateUser(cb) {
                auth(req, cb);
            }],

            'operations': ['username', async.apply(parseOperations, req)],

            'result': ['operations', async.apply(runOperations, req)]

        }, function (err, results) {
            var message, status;

            if (!res) {

                // (req = request, next = callback)
                return next(err, results.result);

            } else if ('function' === typeof next) {

                // (req = request, res = response, next = function)
                if (ERROR_WRONG_ROUTE === err) {
                    // skip to next middleware
                    return next();
                } else if (err) {
                    // some error
                    return next(err);
                }

                status = HTTP_OK;
                message = JSON.stringify(results.result);

            } else {

                // (req = request, res = response)
                if (err) {
                    status = HTTP_ERROR;
                    message = JSON.stringify({err: err.toString()});
                } else {
                    status = HTTP_OK;
                    message = JSON.stringify(results.result);
                }

            }

            res.writeHead(status, {
                'Content-Length': message.length,
                'Content-Type': 'application/json'
            });
            res.end(message);
        });

    };


    /**
     * @param {Request} req (body must be parsed)
     * @param {function (err:Error?, operations: {params:*, operations:{typeId:string,op:string,spec:Spec?,val:*}[]}?)} cb
     * @param {{username: string}} results
     */
    function parseOperations(req, cb, results) {

        var reqMethod = req.method;
        var reqBody = results.reqBody;
        var url = results.url;
        var pathname = decodeURIComponent(url.pathname);
        pathname = pathname.substr(route.length);

        if (!pathname || pathname === '/' || ['GET', 'POST', 'PUT'].indexOf(reqMethod) === -1) {
            return cb(new Error(ErrCode.UNSUPPORTED_REQUEST_FORMAT));
        }

        if ('GET' === reqMethod) {
            // (1) GET, url is a type-id spec "/Type1#id1#id2.../Type2#id1#id2...", no body
            // result is a JSON with object pojos for requested objects {"/Type1#id1": {object_state}, "/Type1#id2": {...} ...}
            parseReadOperations(pathname, cb);
        } else {
            // (2) POST, url is a spec "/Type#id.op", body is a value-json
            parseOperationFromUrl(pathname, reqBody, cb);
        }


        /**
         *
         * @param {string} pathname request pathname
         * @param {function(Error?, {typeId:string, op:string}[]?)} cb
         */
        function parseReadOperations(pathname, cb) {
            Spec.reQTokExt.lastIndex = 0;
            var type, m;
            var res = [];
            while (m = Spec.reQTokExt.exec(pathname)) {
                var tok = m[0];
                var quant = m[1];
                switch (quant) {

                case '/':
                    type = tok;
                    break;

                case '#':
                    if (!type) {
                        return cb(new Error(ErrCode.NO_TYPE_SPECIFIED));
                    }
                    var typeId = type + tok;
                    res.push({
                        typeId: typeId,
                        op: 'on'
                    });
                    break;

                default:
                    return cb(new Error(ErrCode.UNSUPPORTED_TOKEN));
                }
            }
            if (!res.length) {
                return cb(new Error(ErrCode.NO_OPERATIONS_SPECIFIED));
            }

            cb(null, res);
        }

        /**
         * Parses and validates specifier from url, then reads value from request body.
         *
         * @param {string} pathname
         * @param {*} reqBody parsed request body as an object
         * @param {function(Error?, {typeId:string, op:string, spec:Spec, val:*}[]?)} cb
         */
        function parseOperationFromUrl(pathname, reqBody, cb) {
            var spec;
            try {
                spec = new Spec(pathname);
            } catch (err) {
                return cb(err);
            }
            if (!spec.type()) { return cb(new Error(ErrCode.NO_TYPE_SPECIFIED)); }
            if (!spec.id()) { return cb(new Error(ErrCode.NO_ID_SPECIFIED)); }
            if (!spec.op()) { return cb(new Error(ErrCode.NO_OP_SPECIFIED)); }

            var value;
            if ('object' === typeof reqBody) {
                value = {};
                for (var key in reqBody) {
                    // skip some special param names
                    if (SpecialReqParams.indexOf(key) > -1) {
                        continue;
                    }
                    value[key] = reqBody[key];
                }
            } else {
                value = reqBody;
            }

            cb(null, [{
                typeId: spec.typeid(),
                op: spec.op(),
                spec: spec,
                val: value
            }]);
        }
    }

    /**
     * Opens objects, then applies specified operations, then closes objects
     *
     * @param {Request} req
     * @param {function(err: Error?, result: object?)} cb
     * @param {{username:string, reqQuery:*, reqBody:*, operations: {typeId: string, op: string, spec: Spec?, val: *?}[]}} results
     */
    function runOperations(req, cb, results) {
        var operations = results.operations;
        var userSessionId = results.username + '~api~' + host._id;

        var p_expandCollection = !!getParam(req, PARAM_COLLECTION_ENTRIES);
        var p_addVersion = !!getParam(req, PARAM_ADD_VERSION_INFO);

        var fakePipe = {
            _id: userSessionId,
            errors: {},

            deliver: function (spec, val) {
                var typeId = spec.typeid();
                if (spec.op() === 'error') {
                    this.errors[typeId] = val;
                }
            },

            error: function (spec, message) {
                var typeId = spec.typeid();
                this.errors[typeId] = message;
            }

        };

        async.auto({
            objects: makeObjectsList,
            open: ['objects', openObjects],
            exec: ['open', deliverOperations],
            close: ['exec', closeObjects]
        }, function returnResult(err, results) {
            if (err) {
                return cb(err);
            }
            cb(null, results.exec);
        });

        /**
         * Create hash which keys specify objects to open
         *
         * @param {function(err: Error?, typeId2true: *)} cb
         */
        function makeObjectsList(cb) {
            var objects = {};
            // collect typeIds of objects
            operations.forEach(function (op) {
                var typeId = op.typeId;
                if (!objects[typeId]) {
                    objects[typeId] = true;
                }
            });
            cb(null, objects);
        }

        /**
         * Opens objects so if client pipe was opened.
         *
         * @param {function(Error?)} cb
         * @param {{objects: *}} results
         */
        function openObjects(cb, results) {

            var objects = results.objects;

            // open objects
            async.eachLimit(Object.keys(objects), MAX_PARALLEL_OBJECTS, function openSingleObject(typeId, cb) {
                var on_spec = new Spec(typeId + '!' + genVersionId(userSessionId) + '.on');
                host.deliver(on_spec, '!0', fakePipe);
                var obj = host.get(typeId);
                objects[typeId] = obj;
                if ('function' === typeof obj.onObjectStateReady && p_expandCollection) {
                    obj.onObjectStateReady(function onCollectionReady() {
                        cb();
                    });
                } else {
                    host.once(typeId + '.init', function onObjectReady() {
                        cb();
                    });
                }
            }, function onAllLoaded(err) {
                if (err) {
                    cb(err);
                } else {
                    cb();
                }
            });
        }

        /**
         * Apply operations on opened objects
         *
         * @param {function(err: Error?, result: *)} cb
         * @param {{objects: *}} results
         */
        function deliverOperations(cb, results) {

            var objects = results.objects;
            var res = {};

            operations.forEach(function deliverSingleOperation(op) {
                var typeId = op.typeId;
                var obj = objects[typeId];
                if (op.op === 'on') {
                    var pojo = obj.pojo(p_addVersion);
                    if ('function' === typeof obj.onObjectStateReady && p_expandCollection) {
                        pojo.entries.forEach(function (entryAsTypeId, idx) {
                            var entryObj = host.get(entryAsTypeId);
                            var entryAsPojo = entryObj.pojo(p_addVersion);
                            entryAsPojo._type = entryObj._type;
                            entryAsPojo._id = entryObj._id;
                            // replace /Type#id string with object pojo
                            pojo.entries[idx] = entryAsPojo;
                        });
                    }
                    res[typeId] = pojo;
                } else {
                    var spec = op.spec.set(genVersionId(userSessionId), '!');
                    host.deliver(spec, op.val, fakePipe);
                    if (fakePipe.errors[typeId]) {
                        res[spec] = fakePipe.errors[typeId];
                    }
                }
            });
            cb(null, res);
        }

        /**
         * Closes opened objects
         *
         * @param {function(Error?)} cb
         * @param {{objects: *}} results
         */
        function closeObjects(cb, results) {
            var objects = results.objects;
            Object.keys(objects).forEach(function closeSingleObject(typeId) {
                var off_spec = new Spec(typeId + '!' + genVersionId(userSessionId) + '.off');
                host.deliver(off_spec, '', fakePipe);
            });
            cb();
        }

        /**
         * Generates new version with specified processId
         *
         * @param {string} processId processId
         * @return {string}
         */
        function genVersionId(processId) {
            return host.time().replace('+' + host._id, '+' + processId);
        }
    }
}

exports.createHandler = createHandler;

/**
 * Returns request parameter value
 * @param {Request} req request
 * @param {string} param request parameter name
 * @return {*} request parameter value
 */
function getParam(req, param) {
    var query_params = getReqQuery(req);
    if (query_params[param]) {
        return query_params[param];
    }
    return req.body[param];
}

/**
 * @param req request
 * @return {*} parsed request query
 */
function getReqQuery(req) {
    if (!req.query) {
        var val = parseurl(req).query;
        req.query = qs.parse(val);
    }
    return req.query;
}

/**
 * Default user authentications function, it gets username from request param
 * @param {Request} req request
 * @param {function(err: Error?, username: string?)} cb
 */
function auth_usernameFromParam(req, cb) {
    try {
        var user = getParam(req, PARAM_USER);
        if (!user) {
            cb(new Error(ErrCode.NOT_AUTHENTICATED));
        } else {
            cb(null, user);
        }
    } catch (err) {
        cb(err);
    }
}

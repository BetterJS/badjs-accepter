/* global process, global, GLOBAL */
var connect = require('connect'),
    log4js = require('log4js'),
    logger = log4js.getLogger();

var path = require("path");

var cluster = require('cluster');
var argv = process.argv.slice(2);

var REG_REFERER = /^https?:\/\/[^\/]+\//i;
var REG_DOMAIN = /^(?:https?:)?(?:\/\/)?([^\/]+\.[^\/]+)\/?/i;

if (argv.indexOf('--debug') >= 0) {
    logger.setLevel('DEBUG');
    global.debug = true;
} else {
    logger.setLevel('INFO');
}

if (argv.indexOf('--project') >= 0) {
    GLOBAL.pjconfig = require(path.join(__dirname , 'project.debug.json'));
} else {
    GLOBAL.pjconfig = require(path.join(__dirname , 'project.json'));
}

if (cluster.isMaster) {

    var clusters = [];
    // Fork workers.
    for (var i = 0; i < 4; i++) {
        var forkCluster = cluster.fork();
        clusters.push(forkCluster);
    }

    setTimeout(function() {
        require('./service/ProjectService')(clusters);
    }, 3000);

    return;
}

var interceptor = require('c-interceptor')();
var interceptors = GLOBAL.pjconfig.interceptors;

interceptors.forEach(function(value, key) {
    var one = require(value)();
    interceptor.add(one);
});
interceptor.add(require(GLOBAL.pjconfig.dispatcher.module)());

var forbiddenData = '403 forbidden';

global.projectsInfo = {};

var get_domain = function(url){
    return (url.toString().match(REG_DOMAIN) || ['', ''])[1].replace(/^\*\./, '');
};

var genBlacklistReg = function(data){
    // ip黑名单正则
    var blacklistIPRegExpList = [];
    (data.blacklist &&  data.blacklist.ip ? data.blacklist.ip : []).forEach(function (reg) {
        blacklistIPRegExpList.push(new RegExp("^" + reg.replace(/\./g , "\\.")) );
    });
    data.blacklistIPRegExpList = blacklistIPRegExpList

// ua黑名单正则
    var blacklistUARegExpList = [];
    ( data.blacklist &&   data.blacklist.ua ?  data.blacklist.ua : []).forEach(function (reg) {
        blacklistUARegExpList.push(new RegExp(reg , "i"));
    });
    data.blacklistUARegExpList = blacklistUARegExpList

};

process.on('message', function(data) {
    var json = data;
    var info = JSON.parse(json.projectsInfo);
    if (typeof info === "object") {
        for (var k in info) {
            var v = info[k] || {};
            v.domain = get_domain(v.url);
            genBlacklistReg(v  );
        }
        global.projectsInfo = info;
    }
});

/**
 * 校验来源的url 是否和填写的url相同
 * @param id
 * @param req
 * @returns {boolean}
 */
var referer_match = function(id, req) {
    var referer = (((req || {}).headers || {}).referer || "").toString();
    // no referer
    if (!referer) {
        logger.debug('no referer ,  forbidden :' + req.query.id);
        return false;
    }
    var domain = (referer.match(REG_REFERER) || [""])[0] || "";
    return typeof global.projectsInfo === "object" &&
        domain.indexOf((global.projectsInfo[id.toString()] || {}).domain) !== -1;
};

var reponseReject = function (req , res , responseHeader){
    responseHeader['Content-length'] = forbiddenData.length;
    res.writeHead(403, responseHeader);
    res.write(forbiddenData);
    res.end();
}

/**
 * 接收上报 处理 回应
 * @param req connect request
 * @param res connect response
 * @param params 上报参数
 */
var handleReport = function (req, res, params) {
    logger.debug('===== get a message =====');

    var responseHeader = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'image/jpeg',
        'Connection': 'close'
    };

    var id = params.id - 0;
    if (isNaN(id) ||
        id <= 0 ||
        id >= 9999 ||
        !global.projectsInfo[id + ""] ||
        !referer_match(id, req)) {

        reponseReject(req , res , responseHeader);
        logger.debug('forbidden :' + params.id);

        return;
    }

    params.id = id;

    try {
        interceptor.invoke({
            req: req,
            data: params
        });
    } catch (err) {
        reponseReject(req , res , responseHeader);
        logger.debug('id ' +  params.id +' , interceptor error :' + err );
        return;
    }

    if(req.throwError){
        reponseReject(req , res , responseHeader);
        logger.debug('id ' +  params.id +' , interceptor reject :' + req.throwError);
        return;
    }

    // responseHeader end with 204
    responseHeader['Content-length'] = 0;
    res.writeHead(204, responseHeader);

    logger.debug('===== complete a message =====');
    res.end();
}

connect()
    // accept GET report only
    .use('/badjs', connect.query())
    .use('/badjs', function(req, res) {
        handleReport(req,res,req.query);
    })
    // accept POST report only
    .use('/post_badjs', connect.bodyParser())
    .use('/post_badjs',function (req, res) {
        handleReport(req,res,req.body);
    })
    .listen(GLOBAL.pjconfig.port);

logger.info('start badjs-accepter , listen ' + GLOBAL.pjconfig.port + ' ...');

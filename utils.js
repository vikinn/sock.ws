'use strict';

// utils.js
const crypto = require('crypto');
const fs = require('fs');
const util = require('util');

const keys = {
    key: fs.readFileSync(__dirname + '/keys/privkey.pem'),
    cert: fs.readFileSync(__dirname + '/keys/fullchain.pem')
};

exports.keys = keys;

// 加密
exports.encrypt = (data) => {
    // 先用私钥加密得到Buffer
    const buffer = crypto.privateEncrypt(keys.key, data);

    return buffer;
};

// 解密方法
exports.decrypt = (data) => {
    // 使用公钥解密得到解密后的buffer
    const buffer = crypto.publicDecrypt(keys.cert, data);

    return buffer;
};

exports.hash = function(algorithm, data){
    const hash = crypto.createHash(algorithm);
    hash.update(data);
    return hash.digest('hex');
};

exports.hmac = function(algorithm, key, data){
    const hmac = crypto.createHmac(algorithm, key);
    hmac.update(data);
    return hmac.digest('hex');
};

// 自定义不可逆摘要
exports.myHash = function(data, key2){
    const key1 = `ツ☼☁❅♒✎©妌妍妎妏妐妑妔妕ﬅぬ`;
    key2 = key2 || key1;

    const v1 = exports.encrypt(data);
    const v2 = exports.hmac('md5', key1, v1);
    const v3 = exports.hmac('md5', key2, v2);

    return v3;
};

exports.encryptTest = ()=>{
    // encrypt test
    const plainText = `ツ☼☁❅♒✎©妌妍妎妏妐妑妔妕ﬅぬ`;
    const srcData = Buffer.from(plainText, 'utf8');

    const crypted = exports.encrypt(srcData); // 加密
    const decrypted = exports.decrypt(crypted); // 解密

    const dstText = decrypted.toString();
    console.assert(srcData == dstText);
}

exports.encryptTest();

exports.fs = {
    open: util.promisify(fs.open),
    close: util.promisify(fs.close),

    read: util.promisify(fs.read),
    
    readFile: util.promisify(fs.readFile),
    writeFile: util.promisify(fs.writeFile),
    appendFile: util.promisify(fs.appendFile),

    stat: util.promisify(fs.stat),

    exists: util.promisify(fs.exists),
    mkdir: util.promisify(fs.mkdir),
    readdir: util.promisify(fs.readdir),
    
    // mkdir: util.promisify(fs.mkdir),
    // mkdir: util.promisify(fs.mkdir),
    // mkdir: util.promisify(fs.mkdir),
    // mkdir: util.promisify(fs.mkdir),
    // mkdir: util.promisify(fs.mkdir),
    // mkdir: util.promisify(fs.mkdir),
    // mkdir: util.promisify(fs.mkdir),
};

// 读取json
exports.fs.readJSON = async(filename)=>{
    return await exports.fs.readFile(filename).then(
        buffer=> JSON.parse(buffer.toString())
    )
}

// 保存json,成功返回true, 失败返回false
exports.fs.saveJSON = async (filename, data) => {
    try{
        const json = JSON.stringify(data, null, '\t');
        const err = await exports.fs.writeFile(filename, json);

        if(err) return false;
        return true;
    }catch(err){}

    return false;
}


exports.constantize = (obj) => {
    Object.freeze(obj);
    Object.keys(obj).forEach( (key, i) => {
      if ( typeof obj[key] === 'object' ) {
        constantize( obj[key] );
      }
    });
};

exports.Later = function Later(timeout, callback){
    console.assert(timeout && callback);

    let timer = null;

    this.trigger = ()=>{
        timer && clearTimeout(timer);
        timer = setTimeout(exec, timeout);
    };

    this.trigger(); // 触发一次

    function exec(){
        console.assert(callback);
        callback();
        callback = null;
    }
}
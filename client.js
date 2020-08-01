
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const EventEmitter = require('events').EventEmitter;
const utils = require('./utils');

const WS = require('ws');
const { domain, send } = require('process');
const { get } = require('http');
const { resolve } = require('path');
const { type } = require('os');

const config = JSON.parse(fs.readFileSync('client_config.json'));

const MAGIC = Buffer.from('sock.ws');

const VERSION = {
    FIVE: 0x5,
};

const AUTH = {
    NOAUTH: 0x0,
};

const ADDRESS_TYPE = {
    IPV4: 0x1,
    DOMAIN: 0x3,
    IPV6: 0x4,
};

const REQUEST_TYPE = {
    CONNECT: 0x1,
    BIND: 0x2,
    UDP_ASSOCIATE: 0x3,
};


class WSServer extends WS {
    static count(up_len, dn_len){
        this.up = this.up || 0;
        this.dn = this.dn || 0;
        this.count_time = this.count_time || 0;

        this.up += up_len;
        this.dn += dn_len;

        const current_time = new Date;
        const time = current_time - this.count_time;
        if(time > 1000){
            const up = this.up - (this.count_up || 0);
            const dn = this.dn - (this.count_dn || 0);

            this.up_speed = up / time;
            this.dn_speed = dn / time;

            console.log(`${this.up_speed.toFixed(2)}, ${this.dn_speed.toFixed(2)}`);

            this.count_time = current_time;
            this.count_up = this.up;
            this.count_dn = this.dn;
        }

    }

    constructor(url) {
        super(url);
        
        this.url = url;
        this.tunnels = new Map();

        this.on('message', message=>{
            WSServer.count(0, message.length);

            const headers = message.slice(0, 16);
            const data = message.slice(16);

            const magic = headers.slice(0, 7).toString();
            const guid = headers.slice(7, 15).readBigUInt64BE();
            const op = headers.slice(15, 16).toString();

            console.assert(magic == MAGIC.toString());

            const tunnel = this.tunnels.get(guid);

            if (tunnel) {
                tunnel.emit('data', data, op);
            }
        });

        this.on('error', err=>{
            console.error(err);
            for(const [key, value] of this.tunnels){
                value.emit('error', err);
            }
        });

        this.on('close', (code, reason)=>{
            for(const [key, value] of this.tunnels){
                value.emit('close', code, reason);
            }
        });
    }

    async write(data){
        this.send(data);

        WSServer.count(data.length, 0);
    }

    createTunnel(){
        const tunnel = new Tunnel(this);
        this.tunnels.set(tunnel.guid.readBigUInt64BE(), tunnel);

        return tunnel;
    }

    closeTunnel(guid){
        this.tunnels.delete(guid);
    }
}

class Tunnel extends EventEmitter {
    constructor(server) {
        super();

        this.OP = {
            OPEN: 'O',
            CLOSE: 'C',
            DATA: 'D',
            PING: 'P',
        };

        this.server = server;
        this.guid = Buffer.from(Math.random().toString(32)).slice(2, 10);
    }

    destroy (){
        this.server.tunnels.delete(this.guid);
    };

    async write(data, operation){
        const buffer = Buffer.from([
            ...MAGIC,
            ...this.guid,
            String.prototype.charCodeAt.call(operation),
            ...data,
        ]);

        return await this.server.write(buffer);
    }

    async open(host, port){
        const port_buf = Buffer.allocUnsafe(2);
        port_buf.writeUInt16BE(port);

        // 请求
        const buffer = Buffer.from([
            host.length,
            ...Buffer.from(host),
            ...port_buf,
        ]);

        // 打开tunnel
        await this.write(buffer, this.OP.OPEN);

        const success = await Promise.race([
            new Promise(resolve => {
                this.once('data', (data, op)=>{
                    const success = op == this.OP.OPEN;
                    resolve(success);
                });
            }),

            new Promise(resolve=>{
                setTimeout(resolve, config.timeout);
            }),
        ]);

        return success;
    }
}

//创建socks5监听
const server = net.createServer(socket => {
    // socket 是一个双工流
    // logger('client connected');

    const getSocket = (() => {
        const o = { socket, };

        // 服务器收到客户端发出的关闭请求时，会触发end事件
        socket.on('end', () => {
            // logger('client disconnected');

        });
        socket.on('close', () => {
            // logger('client closed');

        });
        socket.on('error', function (error) {
            error.userdata = socket.userdata;
            const { remoteAddress, remotePort, hostname, port_number } = error.userdata || {};

            console.error(`${error.code} ${remoteAddress}:${remotePort} -> ${hostname}:${port_number}`);
        });


        return () => o.socket;
    })();

    getSocket().once('data', function auth(data) {
        // 校验版本
        const version = data[0];
        if (version != VERSION.FIVE) {
            getSocket.write(Buffer.from([version.FIVE, 0xff,]));
            return;
        }

        // 无需校验
        getSocket().write(Buffer.from([VERSION.FIVE, AUTH.NOAUTH]));

        // 处理请求
        getSocket().once('data', async function request(data) {
            {

                // 请求格式
                // +----------+------------+---------+-----------+-----------------------+------------+
                // |协议版本号 | 请求的类型  |保留字段  |  地址类型 |  地址数据              |  地址端口   |
                // +----------+------------+---------+-----------+-----------------------+------------+
                // |1个字节    | 1个字节    |1个字节   |  1个字节  |  变长                  |  2个字节   |
                // +----------+------------+---------+-----------+-----------------------+------------+
                // |0x05      | 0x01       |0x00     |  0x01     |  0x0a,0x00,0x01,0x0a  |  0x00,0x50 |
                // +----------+------------+---------+-----------+-----------------------+------------+

                // 响应数据
                // +----------+--------+---------+-----------+---------------------+------------+
                // |协议版本号 | 状态码 |保留字段  |  地址类型 |  绑定的地址          |顷绑定的端口 |   
                // +----------+--------+---------+-----------+---------------------+------------+
                // |1个字节    | 1个字节 |1个字节  |  1个字节  |  变长                |2个字节     |
                // +----------+--------+---------+-----------+---------------------+------------+
                // |0x05      | 0x00   |0x00     |  0x01     |  0x0a,0x00,0x01,0x0a|0x00,0x50   |
                // +----------+--------+---------+-----------+---------------------+------------+

                // 状态码:
                // X00 succeeded
                // X01 general SOCKS server failure
                // X02 connection not allowed by ruleset
                // X03 Network unreachable
                // X04 Host unreachable
                // X05 Connection refused
                // X06 TTL expired
                // X07 Command not supported
                // X08 Address type not supported
                // X09 to X’FF’ unassigned
            }
            const sendResponse = (status_code) => {
                const buffer = Buffer.from(data);
                buffer[1] = status_code;
                getSocket().write(buffer);
            };

            // 解析请求
            const version = data[0];
            const request_type = data[1];

            const address_type = data[3];

            // const address = Array.prototype.join.call(data.slice(4, -2), '.');
            const port = data.slice(-2);
            const port_number = port.readUInt16BE();

            // 准备请求
            let hostname;

            if (address_type == ADDRESS_TYPE.DOMAIN) {
                const address_length = data[4];
                const address = data.slice(5, 5 + address_length);
                hostname = address.toString();

                // const dns_info = await new Promise(r => {
                //     dns.lookup(address.toString(), (err, address, family) => r({ err, address, family }));
                // });

                // if (dns_info.family == 4) {
                //     // address_type = ADDRESS_TYPE.IPV4;
                //     // address = Buffer.from(dns_info.address.split('.').map(e=>+e));
                //     hostname = dns_info.address;
                // } else if (dns_info.family == 6) {
                //     // address_type = ADDRESS_TYPE.IPV6;
                //     // address =
                //     hostname = dns_info.address;
                //     // debugger;
                // } else {
                //     return sendResponse(0x4);
                // }

            } else if (address_type == ADDRESS_TYPE.IPV4) {
                const address = data.slice(4, 8);

                hostname = Array.prototype.join.call(address, '.');
            } else if (address_type == ADDRESS_TYPE.IPV6) {
                const address = data.slice(4, 20);

                hostname = address.toString('hex').replace(/(?=(\B)(.{4})+$)/g, ':');
            } else {
                return sendResponse(0x8);
            }

            // 开始请求
            const { remoteAddress, remotePort, remoteFamily } = getSocket();

            getSocket().userdata = { hostname, port_number, remoteAddress, remotePort, remoteFamily };

            logger(`[Client: ${remoteAddress}] connecting to ${hostname}:${port_number}`);

            const status_code = await connect.bind(getSocket(), hostname, port_number, sendResponse, 'ws')();

        });
    });
});

server.listen(config.client_port, () => logger('socks5 proxy running ...')).on('error', err => console.error(err));

function logger() {
    console.log(...arguments);
}

const connect = ((host, port, sendResponse, type)=>{
    let wsserver = {};

    return function connect(host, port, sendResponse, type) {
        type = type || 'direct';
    
        if (type == 'direct') {
            return new Promise(r => {
                const socket = new net.Socket();
    
                socket.on('connect', () => {
                    sendResponse(0x0);
                    this.pipe(socket);
                    socket.pipe(this);
                });
    
                socket.on('error', (err) => {
                    let status_code = 0x3;
    
                    switch (err.errno) {
                        case 'ECONNREFUSED':
                            status_code = 0x5
                            break;
    
                        default:
                            status_code = 0xff;
                            console.error(err.message);
                            break;
                    }
    
                    sendResponse(status_code);
                });
    
                socket.connect(port, host);
            });
        } else if (type == 'ws') {
            return new Promise(async resolve=>{
                const server = await new Promise(async (resolve, reject)=>{
                    if(wsserver.readyState == WSServer.CONNECTING){
                        await new Promise(r=>setTimeout(r, config.timeout));
                        if(wsserver.readyState == WSServer.OPEN){
                            return resolve(wsserver);
                        }
                    }else if(wsserver.readyState == WSServer.OPEN){
                        return resolve(wsserver);
                    }

                    const time = Date.now();
                    const token = utils.myHash(Buffer.from('' + time), config.username + config.password);
                    const url = `${config.server_url}?time=${time}&token=${token}`

                    wsserver = new WSServer(url);
                    wsserver.on('open', ()=>{
                        resolve(wsserver);
                    });
                    wsserver.on('error', (err)=>{
                        reject(err);
                    });

                    setTimeout(()=>reject('ETIMOUT'), config.timeout);
                }).catch(err=>{
                    // console.error(err);
                    return
                });

                if(!server){
                    console.error(`ETIMEOUT: Failed to connected to ${config.server_url}`);
                    return sendResponse(0x3);
                }
    
                const tunnel = await server.createTunnel(host, port);
                const success = await tunnel.open(host, port);
        
                if(!success){

                    // console.error(`ETUNNEL: Tunnel create error ${url}`);
                    return sendResponse(0x3);
                }
                
                // pipe
                tunnel.on('data', data=>{
                    this.writable && this.write(data);
                });

                this.on('data', data=>{
                    tunnel.write(data, tunnel.OP.DATA);
                });

                //
                tunnel.on('error', err=>{
                    sendResponse(0x3);
                });

                tunnel.on('close', (code, reason)=>{
                    sendResponse(0x9);
                });

                sendResponse(0x0);
            });
        }
    }
    
})();



const fs = require('fs');
const https = require('https');
const WS = require('ws');
const net = require('net');

const utils = require('./utils');

const server = https.createServer(utils.keys);
const wss = new WS.Server({ noServer: true });

const MAGIC = Buffer.from('sock.ws');

const sockets = new Map;

const config = JSON.parse(fs.readFileSync('config.json'));

wss.on('connection', function connection(ws) {
    ws.on('message', function incoming(message) {
        const OP = {
            OPEN: 'O',
            CLOSE: 'C',
            DATA: 'D',
            PING: 'P',
            RESPONSE: 'R',
        };

        const headers = message.slice(0, 16);
        const data = message.slice(16);

        const magic = headers.slice(0, 7).toString();
        const guid = headers.slice(7, 15).readBigUInt64BE();
        const op = headers.slice(15, 16).toString();

        const sendResponse = (data, op) => {
            data = data || Buffer.alloc(0);

            const buffer = Buffer.from([...headers, ...data,]);

            buffer[15] = String.prototype.charCodeAt.call(op)

            ws.send(buffer);
        };

        // 开启链接
        if (op == OP.OPEN) {
            const host_length = data[0];
            const host = data.slice(1, 1 + host_length).toString();
            const port = data.slice(1 + host_length, 3 + host_length).readUInt16BE();

            console.log(`connecting to ${host}:${port}`);

            const socket = new net.Socket();

            socket.on('connect', () => {
                sockets.set(guid, socket);

                sendResponse(null, OP.OPEN);

                socket.on('data', data => {
                    sendResponse(data, OP.DATA);
                });
            });

            socket.on('error', (err) => {
                sendResponse(null, OP.CLOSE);

                sockets.delete(guid);
            });

            socket.on('close', (err) => {
                sendResponse(null, OP.CLOSE);

                sockets.delete(guid);
            });

            socket.connect(port, host);
        } else if (op == OP.DATA) {
            const socket = sockets.get(guid);

            if (!socket) {
                return sendResponse(null, OP.CLOSE);
            }

            socket.write(data);
        }
    });
});

wss.on('listening', function () {
    console.log(`Server listening at port ${wss.address().port}`);
});

server.on('upgrade', function upgrade(request, socket, head) {
    // This function is not defined on purpose. Implement it with your own logic.

    const time = request.url.match(/(?<=time=)\d+/)[0];
    const token = request.url.match(/(?<=token=)\w+/)[0];
    const t = utils.myHash(Buffer.from('' + time), config.username + config.password);

    const authPassed = t == token;

    if (authPassed) {
        return wss.handleUpgrade(request, socket, head, function done(ws) {
            wss.emit('connection', ws, request, config.username);
        });
    }

    socket.destroy();
    return;
    
});

server.listen(config.server.port);

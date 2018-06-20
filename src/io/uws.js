import { EventEmitter } from 'events';
import { Multimap } from '../util/multimap';
import clone from 'clone';
import typecheck from 'json-typecheck';
import uws from 'uws';

const LOGGER = require('@calzoneman/jsli')('uws');

const TYPE_FRAME = 0;
const TYPE_ACK = 1;

const rooms = new Multimap();

class UWSContext {
    constructor(upgradeReq) {
        this.upgradeReq = upgradeReq;
        this.ipAddress = null;
        this.torConnection = null;
        this.ipSessionFirstSeen = null;
        this.user = null;
    }
}

class UWSWrapper extends EventEmitter {
    constructor(socket) {
        super();

        this._uwsSocket = socket;
        this._joined = new Set();
        this._connected = true;

        this.context = new UWSContext({
            connection: {
                remoteAddress: socket._socket.remoteAddress
            },
            headers: clone(socket.upgradeReq.headers)
        });
        // socket.io metrics compatibility
        this.client = {
            conn: {
                on: function(){},
                transport: {
                    name: 'uws'
                }
            }
        };

        this._uwsSocket.on('message', message => {
            try {
                this._decode(message);
            } catch (error) {
                LOGGER.warn(
                    'Decode failed (ip=%s): %s',
                    this.context.ipAddress,
                    error
                );
                this.disconnect();
            }
        });

        this._uwsSocket.on('close', () => {
            this._connected = false;

            for (let room of this._joined) {
                rooms.delete(room, this);
            }

            this._joined.clear();
            this._emit('disconnect');
        });
    }

    disconnect() {
        this._uwsSocket.terminate();
    }

    get disconnected() {
        return !this._connected;
    }

    emit(frame, payload) {
        try {
            this._uwsSocket.send(encode(frame, payload));
        } catch (error) {
            LOGGER.error(
                'Emit failed (ip=%s): %s',
                this.context.ipAddress,
                error.stack
            );
            this.disconnect();
        }
    }

    join(room) {
        this._joined.add(room);
        rooms.set(room, this);
    }

    leave(room) {
        this._joined.delete(room);
        rooms.delete(room, this);
    }

    typecheckedOn(frame, typeDef, cb) {
        this.on(frame, (data, ack) => {
            typecheck(data, typeDef, (err, data) => {
                if (err) {
                    this.emit('errorMsg', {
                        msg: 'Unexpected error for message ' + frame + ': ' +
                             err.message
                    });
                } else {
                    cb(data, ack);
                }
            });
        });
    }

    typecheckedOnce(frame, typeDef, cb) {
        this.once(frame, (data, ack) => {
            typecheck(data, typeDef, (err, data) => {
                if (err) {
                    this.emit('errorMsg', {
                        msg: 'Unexpected error for message ' + frame + ': ' +
                             err.message
                    });
                } else {
                    cb(data, ack);
                }
            });
        });
    }

    _ack(ackId, payload) {
        this._uwsSocket.send(JSON.stringify({
            type: TYPE_ACK,
            ackId,
            payload
        }));
    }

    _decode(message) {
        const { frame, type, ackId, payload } = JSON.parse(message);

        if (type !== TYPE_FRAME) {
            LOGGER.warn(
                'Unexpected message type %s from client; dropping',
                type
            );
            return;
        }

        const args = [payload];

        if (typeof ackId === 'number') {
            args.push(payload => {
                try {
                    this._ack(ackId, payload);
                } catch (error) {
                    LOGGER.error('Error in ack callback: %s', error.stack);
                }
            });
        }

        this._emit(frame, ...args);
    }
}

Object.assign(UWSWrapper.prototype, { _emit: EventEmitter.prototype.emit });

class UWSServer extends EventEmitter {
    constructor() {
        super();

        this._server = new uws.Server({ port: 3000, host: '127.0.0.1' });
        this._middleware = [];

        this._server.on('connection', socket => this._onConnection(socket));
        this._server.on('listening', () => this.emit('listening'));
        this._server.on('error', e => this.emit('error', e));
    }

    use(cb) {
        this._middleware.push(cb);
    }

    _onConnection(uwsSocket) {
        const socket = new UWSWrapper(uwsSocket);

        if (this._middleware.length === 0) {
            this._acceptConnection(socket);
            return;
        }

        let i = 0;
        const self = this;
        function next(error) {
            if (error) {
                socket.emit('error', error.message);
                socket.disconnect();
                return;
            }

            if (i >= self._middleware.length) {
                self._acceptConnection(socket);
                return;
            }

            process.nextTick(self._middleware[i], socket, next);
            i++;
        }

        process.nextTick(next, null);
    }

    _acceptConnection(socket) {
        socket.emit('connect');
        this.emit('connection', socket);
    }

    shutdown() {
        this._server.close();
    }
}

function encode(frame, payload) {
    return JSON.stringify({
        type: TYPE_FRAME,
        frame,
        payload
    });
}

function inRoom(room) {
    return {
        emit(frame, payload) {
            const encoded = encode(frame, payload);

            for (let wrapper of rooms.get(room)) {
                wrapper._uwsSocket.send(encoded);
            }
        }
    };
}

export { UWSServer };
exports['in'] = inRoom;

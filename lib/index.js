var nn = require('bindings')('node_nanomsg.node');

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var stream = require('stream');

/**
 * Socket implementation
 */

function Socket(domain, type) {
    // DO NOT attempt to rename to this.domain, unless you like EventEmitter pain!
    this.af_domain = domain;
    this.type = type;

    if ((domain != nn.AF_SP) && (domain != nn.AF_SP_RAW)) {
        throw new Error('unrecognised socket domain');
    }

    switch (type) {
        case 'req':
            this.protocol = nn.NN_REQ;
            this.sender = true;
            this.receiver = true;
            break;

        case 'rep':
            this.protocol = nn.NN_REP;
            this.sender = true;
            this.receiver = true;
            break;

        case 'pair':
            this.protocol = nn.NN_PAIR;
            this.sender = true;
            this.receiver = true;
            break;

        case 'push':
            this.protocol = nn.NN_PUSH;
            this.sender = true;
            this.receiver = false;
            break;

        case 'pull':
            this.protocol = nn.NN_PULL;
            this.sender = false;
            this.receiver = true;
            break;

        case 'pub':
            this.protocol = nn.NN_PUB;
            this.sender = true;
            this.receiver = false;
            break;

        case 'sub':
            this.protocol = nn.NN_SUB;
            this.sender = false;
            this.receiver = true;
            break;

        case 'bus':
            this.protocol = nn.NN_BUS;
            this.sender = true;
            this.receiver = true;
            break;

        case 'surveyor':
            this.protocol = nn.NN_SURVEYOR;
            this.sender = true;
            this.receiver = true;
            break;

        case 'respondent':
            this.protocol = nn.NN_RESPONDENT;
            this.sender = true;
            this.receiver = true;
            break;

        default:
            throw new Error('unrecognised socket type ' + type);
            break;
    }

    this.binding = nn.Socket(this.af_domain, this.protocol);
    this.queue = [];

    if (this.af_domain == nn.AF_SP) {
        if (this.receiver) this._startPollReceive();
    }

    stream.Duplex.call(this, {
        objectMode: true
    });
}

util.inherits(Socket, stream.Duplex);

Socket.prototype._read = function(n) {
    if (this.receiver)
        this._startPollReceive();
    else
        throw 'read not implemented: ' + this.type;
};

Socket.prototype._write = function(chunk, encoding, callback) {

    if (!(chunk instanceof Array)) chunk = [chunk, 0];

    if (this.sender) 
      this._send(chunk[0], chunk[1], callback);
    else
      throw 'write not implemented: ' + this.type;
};

Socket.prototype._protect = function(ret, unwind) {
    if (ret < 0) {
        if (unwind) unwind.call(this);
        this.emit('error', new Error(nn.Strerr(nn.Errno())));
        return null;
    }
    return ret;
};

/* like _protect, but ret is an array where the first element
 * is the error code (0=good, <0=bad), and the second element
 * is the value to return if there was no error.
 */
Socket.prototype._protectArray = function(ret, unwind) {
    if (ret[0] < 0) {
        if (unwind) unwind.call(this);
        this.emit('error', new Error(nn.Strerr(nn.Errno())));
        return null;
    }
    return ret[1];
};

Socket.prototype._send = function(buf, flags, callback) {
    var self = this;


    if (this.closed) return;

    if (this.type == 'surveyor') {
        this._startPollReceive();
    }

    if (this.transform && typeof this.transform === 'function') buf = this.transform(buf);
    if (!Buffer.isBuffer(buf)) buf = new Buffer(buf);
    flags = flags | nn.NN_DONTWAIT;
    var err = nn.Send(this.binding, buf, flags);

    if (err < 0) {
        // EAGAIN means the socket is busy. that's cool, just wait for 
        // the socket to be freed up again (by polling it til it's ready)
        // then re-queue up all my junk

        var errno = nn.Errno();

        if (errno == nn.EAGAIN) {
            self.queue.push([buf, flags, callback]);
            self._startPollSend();
        } else {
          this.emit('error', new Error(nn.Strerr(errno)));
        }
    } else {
        if (callback) callback();
    }
};

Socket.prototype._receive = function(max) {
    var done = false,
        count = 0;

    if (typeof max === 'undefined') max = 5;

    while (!done) {

        if (count > max) {
            return;
        };

        var msg = nn.Recv(this.binding, nn.NN_DONTWAIT);

        count++;

        if (msg < 0) {
            var errno = nn.Errno();

            if (errno == nn.EAGAIN) {
                // no data, but not   
                if (this.closed) this.push(null);
                done = true;
                break;
            };

            if (this.type == 'surveyor') {
                if (errno == nn.EFSM) {
                    this._stopPollSend();
                    this._stopPollReceive();
                    this.emit('survey-timeout');
                    done = true;
                    break;
                }
            }

            if (msg == -1) {
                // if socket is still present, then bubble up the error 
                if (!this.closed) this.emit('error', new Error(nn.Strerr(errno)));
                done = true;
                break;
            };
        };

        if (this.restore && typeof this.restore === 'function') msg = this.restore(msg);

        // support the old api
        var pushed = this.push(msg);


        if (!pushed) {
            // we're paused
            this._stopPollReceive();
            done = true;
        };

        this.emit('message', msg);
    }
};


Socket.prototype._startPollSend = function() {
    if (!this._pollSend) {
        this._pollSend = nn.PollSendSocket(this.binding, function(events) {
            if (events) this.flush();
        }.bind(this));
    }
}

Socket.prototype._startPollReceive = function() {
    if (!this._pollReceive) {
        this._pollReceive = nn.PollReceiveSocket(this.binding, function(events) {
            if (events) {
                this._receive();
            }
        }.bind(this));
    }
}

Socket.prototype._stopPollSend = function() {
    if (this._pollSend) nn.PollStop(this._pollSend);
    this._pollSend = null;
}

Socket.prototype._stopPollReceive = function() {
    if (this._pollReceive) nn.PollStop(this._pollReceive);
    this._pollReceive = null;
}



/**
 * Socket API
 */

Socket.prototype.bind = function(addr) {
    this.id = this._protect(nn.Bind(this.binding, addr));
    return this.id;
}

Socket.prototype.connect = function(addr) {
    this.id = this._protect(nn.Connect(this.binding, addr));
    return this.id;
}

Socket.prototype.flush = function() {
    //
    // no need to poll for socket availability anymore
    //
    this._stopPollSend();

    while (this.queue.length) {
        var entry = this.queue.shift();
        this._send(entry[0], Number(entry[1]) || 0, entry[2]);
    }
};

/**
 * close the socket
 *
 * set `now` to false to wait for the tcp|ipc buffers to drain on a read
 * socket, and for all pending writes to finish up.
 *
 * @param {Boolean} now - shutdown immediately (default is true) 
 */
Socket.prototype.close = function(now) {
    var self = this;

    if (typeof now == 'undefined')
        now = true;

    if (!this.closed) {
        // Prevent "Bad file descriptor" from recursively firing "error" event

        this._stopPollSend();
        this._stopPollReceive();

        if (now) {
            //
            // force closure now
            this.closed_status = nn.Close(this.binding);
            this.closed = true;
            this.emit('close');
        } else {
            // 
            // one we're done reading and writing, then end
            var result = nn.Shutdown(this.binding, this.id);

            // flush any leftover data
            if (this.receiver) this._receive(100);

            this.once('end', function() {
                if (!self.closed_status) {
                    self.closed_status = nn.Close(self.binding);
                    self.emit('close');
                }
            });
            this.closed = true;
        };

        return this.closed_status;
    }

    // TODO: AJS: in the event of multiple close, we remember
    // the return code from the first valid close, and return
    // it for all subsequent close attempts. This appears to be
    // in the spirit of the original author's intention, but
    // perhaps it would be better to return EBADF or some other
    // error?
    return this.closed_status;
};

/**
 * Old send() API maintained for backwards-compatibility.
 *
 * WARNING: do not use if you want any kind of backpressure,
 * use `Socket.write([buf, flags])` directly instead.
 *
 * @deprecated
 */
Socket.prototype.send = function(buf, flags) {
    this.write([buf, flags], null);
    return buf.length;
};

/* returns an int, a string, or throws EBADF, ENOPROTOOPT, ETERM */
Socket.prototype.getsockopt = function(level, option) {
    return this._protectArray(nn.Getsockopt(this.binding, level, option));
};

Socket.prototype.setsockopt = function(level, option, value) {
    return this._protect(nn.Setsockopt(this.binding, level, option, value));
};

Socket.prototype.shutdown = function(how) {
    return this._protect(nn.Shutdown(this.binding, how));
};

/**
 * Type-specific API
 */
Socket.prototype.survey = function(buf, callback) {
    if (!this.type == 'surveyor') {
        throw new Error('Only surveyor sockets can survey.');
    }
    var responses = [];

    function listener(buf) {
        responses.push(buf);
    }
    this.once('survey-timeout', function() {
        this.removeListener('message', listener);
        callback(responses);
    })
    this.on('message', listener);
    this.send(buf);
}


/**
 * Device implementation
 */

function Device(sock1, sock2) {
    var that = this;
    this.sock1 = sock1;
    this.sock2 = sock2;
    this.s1 = -1;
    this.s2 = -1;

    if (sock1 instanceof Socket) {
        this.s1 = sock1.binding;

        if (sock2 instanceof Socket) {
            this.s2 = sock2.binding;
        }

        this._timer = setImmediate(function() {
            nn.DeviceWorker(that.s1, that.s2, function(err) {
                that.emit('error', new Error(nn.Strerr(err)));
            });
        });

    } else {
        throw new Error('expected at least one Socket argument');
    }
}

util.inherits(Device, EventEmitter);

/**
 * module API
 */

function createSocket(type, opts) {
    opts = opts || {};
    var domain = opts.raw ? nn.AF_SP_RAW : nn.AF_SP;
    return new Socket(domain, type);
}

function symbolInfo(symbol) {
    return nn.SymbolInfo(symbol);
}

function symbol(symbol) {
    return nn.Symbol(symbol);
}

function term() {
    return nn.Term();
}

function createDevice(sock1, sock2) {
    return new Device(sock1, sock2);
}

exports._bindings = nn;
exports.Socket = Socket;
exports.createSocket = createSocket;
exports.symbolInfo = symbolInfo;
exports.symbol = symbol;
exports.term = term;
exports.socket = createSocket;
exports.stream = createSocket;

exports.createDevice = createDevice;
exports.device = createDevice;

// 只覆盖阅读器用到的流动读法：word-extractor 监听 data/end，并在 _read 里 push。
const EventEmitter = require('events');

class Readable extends EventEmitter {
  constructor() {
    super();
    this._flowing = false;
    this._reading = false;
  }
  on(type, fn) {
    const ret = super.on(type, fn);
    if (type === 'data') {
      this._flowing = true;
      this._pump();
    }
    return ret;
  }
  _pump() {
    if (!this._flowing || this._reading) return;
    this._reading = true;
    try {
      if (typeof this._read === 'function') this._read();
    } finally {
      this._reading = false;
    }
  }
  push(chunk) {
    if (chunk == null) {
      this._flowing = false;
      this.emit('end');
      return false;
    }
    this.emit('data', chunk);
    if (this._flowing) queueMicrotask(() => this._pump());
    return true;
  }
  read() {
    this._pump();
    return null;
  }
  resume() {
    this._flowing = true;
    this._pump();
    return this;
  }
  pause() {
    this._flowing = false;
    return this;
  }
  pipe(dest) {
    this.on('data', (chunk) => dest.write(chunk));
    this.on('end', () => dest.end && dest.end());
    return dest;
  }
  destroy(err) {
    if (err) this.emit('error', err);
    return this;
  }
}

class Writable extends EventEmitter {
  write(chunk, enc, cb) {
    if (typeof enc === 'function') {
      cb = enc;
      enc = undefined;
    }
    if (typeof this._write === 'function') this._write(chunk, enc, cb || (() => {}));
    else if (cb) cb();
    return true;
  }
  end(chunk, enc, cb) {
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
    }
    if (chunk != null) this.write(chunk, enc);
    this.emit('finish');
    if (typeof cb === 'function') cb();
    return this;
  }
  destroy(err) {
    if (err) this.emit('error', err);
    return this;
  }
}

class Duplex extends Readable {}
class Transform extends Duplex {}
class PassThrough extends Transform {}

module.exports = EventEmitter;
module.exports.Readable = Readable;
module.exports.Writable = Writable;
module.exports.Duplex = Duplex;
module.exports.Transform = Transform;
module.exports.PassThrough = PassThrough;
module.exports.Stream = EventEmitter;

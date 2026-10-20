// 浏览器 Worker 里没有 Node 的 events。exceljs / word-extractor 只用来派发 data/end/error。
function EventEmitter() {
  this._events = Object.create(null);
}

EventEmitter.prototype.on = function on(type, fn) {
  (this._events[type] || (this._events[type] = [])).push(fn);
  return this;
};
EventEmitter.prototype.addListener = EventEmitter.prototype.on;
EventEmitter.prototype.once = function once(type, fn) {
  const self = this;
  function wrap() {
    self.removeListener(type, wrap);
    fn.apply(this, arguments);
  }
  wrap.fn = fn;
  return this.on(type, wrap);
};
EventEmitter.prototype.removeListener = function removeListener(type, fn) {
  const list = this._events[type];
  if (!list) return this;
  this._events[type] = list.filter((item) => item !== fn && item.fn !== fn);
  return this;
};
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
EventEmitter.prototype.removeAllListeners = function removeAllListeners(type) {
  if (type) delete this._events[type];
  else this._events = Object.create(null);
  return this;
};
EventEmitter.prototype.emit = function emit(type) {
  const list = this._events[type];
  if (!list || list.length === 0) return false;
  const args = Array.prototype.slice.call(arguments, 1);
  for (const fn of list.slice()) fn.apply(this, args);
  return true;
};
EventEmitter.prototype.listeners = function listeners(type) {
  return (this._events[type] || []).slice();
};
EventEmitter.prototype.setMaxListeners = function setMaxListeners() {
  return this;
};

module.exports = EventEmitter;
module.exports.EventEmitter = EventEmitter;

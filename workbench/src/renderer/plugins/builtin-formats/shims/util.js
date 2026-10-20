function inherits(ctor, superCtor) {
  if (typeof superCtor !== 'function') throw new TypeError('inherits 的父类不是函数');
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}
function debuglog() {
  return function debug() {};
}
function promisify(fn) {
  return function promisified() {
    const args = Array.prototype.slice.call(arguments);
    return new Promise((resolve, reject) => {
      fn.apply(this, args.concat((error, value) => (error ? reject(error) : resolve(value))));
    });
  };
}

module.exports = {
  inherits,
  debuglog,
  promisify,
  inspect(value) {
    return String(value);
  },
  types: {},
  callbackify(fn) {
    return function callbackified() {
      const args = Array.prototype.slice.call(arguments);
      const cb = args.pop();
      Promise.resolve(fn.apply(this, args)).then((value) => cb(null, value), (error) => cb(error));
    };
  },
};

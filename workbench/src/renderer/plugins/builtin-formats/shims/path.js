function extname(value) {
  const text = String(value);
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  const dot = text.lastIndexOf('.');
  return dot > slash ? text.slice(dot) : '';
}
function basename(value) {
  const text = String(value).replace(/\\/g, '/');
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
}
function dirname(value) {
  const text = String(value).replace(/\\/g, '/');
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(0, slash) : '.';
}
function join() {
  return Array.prototype.slice.call(arguments).filter(Boolean).join('/').replace(/\/+/g, '/');
}

const posix = { extname, basename, dirname, join, sep: '/' };
module.exports = { extname, basename, dirname, join, resolve: join, sep: '/', posix, win32: posix };

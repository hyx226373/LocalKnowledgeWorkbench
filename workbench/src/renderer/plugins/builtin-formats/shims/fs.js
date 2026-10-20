// 版式解析只吃内存里的字节。碰到真实读盘就失败，不把路径带回界面。
function unavailable(name) {
  return function unavailableCall() {
    const cb = arguments[arguments.length - 1];
    const error = new Error('应用内无法读取磁盘：' + name);
    if (typeof cb === 'function') cb(error);
    else throw error;
  };
}

module.exports = {
  open: unavailable('open'),
  read: unavailable('read'),
  close: unavailable('close'),
  readFile: unavailable('readFile'),
  readFileSync() {
    throw new Error('应用内无法读取磁盘');
  },
  existsSync() {
    return false;
  },
  stat: unavailable('stat'),
  promises: {},
};

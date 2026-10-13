/**
 * 应用已经依赖 chokidar，并且 src/main/service/watcher.ts 使用 all/ready。
 * 不要在这里 declare module 'chokidar'，否则会盖住包自己的类型，把根目录监听的事件签名弄窄。
 * 桥的动态 import('chokidar') 走同一份包类型；加载失败时泵只轮询。
 */

import { createApp } from './src/app.js';

const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`无效的 PORT：${JSON.stringify(rawPort)}，应为 0~65535 的整数`);
  process.exit(1);
}

const host = '127.0.0.1';

const { server } = await createApp();

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用；请通过 PORT 环境变量换一个端口`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  const address = server.address();
  console.log(`施工区间公示控制台已启动：http://${host}:${address.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

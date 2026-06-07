import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  plugins: [
    {
      name: 'obsidian-saver',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/api/save-obsidian' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => {
              body += chunk;
            });
            req.on('end', () => {
              try {
                const { folderPath, fileName, content } = JSON.parse(body);
                if (!folderPath || !fileName) {
                  res.statusCode = 400;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: 'Missing folderPath or fileName' }));
                  return;
                }

                // Resolve path (support standard absolute paths)
                const targetDir = path.resolve(folderPath);

                if (!fs.existsSync(targetDir)) {
                  fs.mkdirSync(targetDir, { recursive: true });
                }

                const targetFilePath = path.join(targetDir, fileName);
                fs.writeFileSync(targetFilePath, content, 'utf8');

                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, path: targetFilePath }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: err.message }));
              }
            });
          } else {
            next();
          }
        });
      },
    },
  ],
});

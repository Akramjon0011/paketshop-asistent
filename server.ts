import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config(); // fallback to .env

import express from "express";
import path from "path";
import fs from 'fs';
import { fileURLToPath } from 'url';

import { initDb } from './src/server/db.js';
import { setupBot } from './src/server/bot.js';
import { router } from './src/server/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
app.use(express.json());

// Initialize Database
initDb();

// Setup API Routes
app.use('/api', router);

// Setup Telegram Bot
setupBot(app);

// Setup local dev server or static rendering when NOT in Vercel
if (!process.env.VERCEL) {
  async function setupLocalServer() {
     const PORT = 3000;
     if (process.env.NODE_ENV !== "production") {
         const { createServer: createViteServer } = await import("vite");
         const vite = await createViteServer({
           server: { middlewareMode: true },
           appType: "spa",
         });
         app.use(vite.middlewares);
     } else {
         const distPath = path.join(process.cwd(), 'dist');
         app.use(express.static(distPath));
         app.get('*', (req, res) => {
           if (fs.existsSync(path.join(distPath, 'index.html'))) {
              res.sendFile(path.join(distPath, 'index.html'));
           } else {
              res.send("Build files missing.");
           }
         });
     }
     app.listen(PORT, "0.0.0.0", () => {
         console.log(`Server running on http://localhost:${PORT}`);
     });
  }
  setupLocalServer();
}

export default app;

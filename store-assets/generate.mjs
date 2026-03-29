import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const browser = await chromium.launch();

  // Promotional tile (440x280)
  const page1 = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await page1.goto(`file://${join(__dirname, 'promotional-tile.html')}`);
  await page1.screenshot({ path: join(__dirname, 'promotional-tile-440x280.png') });
  console.log('Created promotional-tile-440x280.png');
  await page1.close();

  // Marquee / large promotional (1280x800)
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page2.goto(`file://${join(__dirname, 'marquee.html')}`);
  await page2.screenshot({ path: join(__dirname, 'marquee-1280x800.png') });
  console.log('Created marquee-1280x800.png');
  await page2.close();

  await browser.close();
  console.log('Done! Store assets generated.');
}

main().catch(console.error);

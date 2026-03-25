/**
 * Сервис обработки изображений (водяной знак)
 */
const sharp = require('sharp');
const fs = require('fs').promises;

/**
 * Наложить водяной знак на изображение
 * @param {Buffer} imageBuffer — исходное изображение
 * @param {string} logoPath — путь к файлу логотипа
 * @param {object} options
 * @param {string} options.position — позиция: northwest, northeast, southwest, southeast
 * @param {number} options.opacity — прозрачность 0-1
 * @param {number} options.scale — доля ширины изображения (0-1)
 * @returns {Promise<Buffer>}
 */
async function overlayWatermark(imageBuffer, logoPath, options = {}) {
  const { position = 'northwest', opacity = 0.4, scale = 0.15 } = options;

  const image = sharp(imageBuffer);
  const meta = await image.metadata();
  const targetWidth = Math.round((meta.width || 1000) * scale);

  let logoBuf;
  try {
    logoBuf = await fs.readFile(logoPath);
  } catch (e) {
    console.warn(`[IMAGE-SERVICE] Logo not found at ${logoPath}, skipping watermark`);
    return imageBuffer;
  }

  const logo = await sharp(logoBuf)
    .resize({ width: targetWidth })
    .ensureAlpha()
    .composite([{
      input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]),
      raw: { width: 1, height: 1, channels: 4 },
      tile: true,
      blend: 'dest-in'
    }])
    .toBuffer();

  const gravityMap = {
    northwest: 'northwest',
    northeast: 'northeast',
    southwest: 'southwest',
    southeast: 'southeast',
    center: 'centre'
  };

  const result = await sharp(imageBuffer)
    .composite([{
      input: logo,
      gravity: gravityMap[position] || 'northwest'
    }])
    .toBuffer();

  return result;
}

module.exports = { overlayWatermark };

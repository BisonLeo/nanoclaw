import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

// --- OCR configuration ---

const OCR_ENV = readEnvFile(['PADDLEOCR_VENV', 'PADDLEOCR_SERVER_URL']);
const PADDLEOCR_VENV =
  process.env.PADDLEOCR_VENV || OCR_ENV.PADDLEOCR_VENV || '/home/leo/padvenv';
const PADDLEOCR_SERVER_URL =
  process.env.PADDLEOCR_SERVER_URL ||
  OCR_ENV.PADDLEOCR_SERVER_URL ||
  'http://192.168.21.48:8080/v1';

const OCR_CACHE_DIR = path.join(DATA_DIR, 'imageocr');
const SHARED_OCR_DIR = path.join(
  os.homedir(),
  '.openclaw',
  'workspace',
  'imageocr',
);

export function isOcrAvailable(): boolean {
  return fs.existsSync(path.join(PADDLEOCR_VENV, 'bin', 'activate'));
}

function runOcr(imagePath: string, outputDir: string): string | null {
  try {
    const cmd = `source "${PADDLEOCR_VENV}/bin/activate" && paddleocr doc_parser -i "${imagePath}" --vl_rec_backend vllm-server --vl_rec_server_url "${PADDLEOCR_SERVER_URL}" --save_path "${outputDir}"`;
    logger.info({ cmd }, 'OCR command');
    execSync(cmd, { shell: '/bin/bash', timeout: 120000, stdio: 'pipe' });

    // Find the markdown output file
    const baseName = path.basename(imagePath, path.extname(imagePath));
    const mdPath = path.join(outputDir, `${baseName}.md`);
    if (!fs.existsSync(mdPath)) {
      // Try to find any .md file in the output
      const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.md'));
      if (files.length === 0) {
        logger.warn(
          { imagePath, outputDir },
          'OCR produced no markdown output',
        );
        return null;
      }
      const altMdPath = path.join(outputDir, files[0]);
      return cleanOcrOutput(fs.readFileSync(altMdPath, 'utf-8'));
    }
    return cleanOcrOutput(fs.readFileSync(mdPath, 'utf-8'));
  } catch (err) {
    logger.error({ err, imagePath }, 'OCR execution failed');
    return null;
  }
}

function cleanOcrOutput(text: string): string {
  let cleaned = text
    // Strip HTML table tags
    .replace(/<\/?table[^>]*>/gi, '')
    .replace(/<\/?thead[^>]*>/gi, '')
    .replace(/<\/?tbody[^>]*>/gi, '')
    .replace(/<\/?tr[^>]*>/gi, '\n')
    .replace(/<\/?th[^>]*>/gi, ' ')
    .replace(/<\/?td[^>]*>/gi, ' ')
    // Strip LaTeX markers
    .replace(/\$\$/g, '')
    .replace(/\$/g, '')
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

interface OcrIndexEntry {
  hash: string;
  source: string;
  chatJid: string;
  sender: string;
  caption: string;
  createdAt: string;
  ocrLength: number | null;
}

const INDEX_PATH = path.join(OCR_CACHE_DIR, 'index.json');

function readOcrIndex(): Record<string, OcrIndexEntry> {
  try {
    if (fs.existsSync(INDEX_PATH)) {
      return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    }
  } catch {
    /* corrupted index, start fresh */
  }
  return {};
}

function writeOcrIndex(index: Record<string, OcrIndexEntry>): void {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

export async function getOcrText(
  imageBuffer: Buffer,
  ext: string,
  meta: { source: string; chatJid: string; sender: string; caption: string },
): Promise<string | null> {
  const hash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

  // Each image gets its own subfolder: data/imageocr/{hash}/
  const hashDir = path.join(OCR_CACHE_DIR, hash);
  fs.mkdirSync(hashDir, { recursive: true });
  const cachePath = path.join(hashDir, 'ocr.txt');

  // Cache hit
  if (fs.existsSync(cachePath)) {
    logger.info({ hash: hash.slice(0, 12) }, 'OCR cache hit');
    return fs.readFileSync(cachePath, 'utf-8');
  }

  // Cache miss — save original image, run OCR into same subfolder
  const imagePath = path.join(hashDir, `original.${ext}`);
  fs.writeFileSync(imagePath, imageBuffer);

  const text = runOcr(imagePath, hashDir);
  if (text) {
    fs.writeFileSync(cachePath, text);
    logger.info(
      { hash: hash.slice(0, 12), length: text.length, dir: hashDir },
      'OCR completed and cached',
    );
  }

  // Update index
  const index = readOcrIndex();
  index[hash] = {
    hash,
    source: meta.source,
    chatJid: meta.chatJid,
    sender: meta.sender,
    caption: meta.caption,
    createdAt: new Date().toISOString(),
    ocrLength: text ? text.length : null,
  };
  writeOcrIndex(index);

  // Sync results to shared workspace so container agents can access them
  try {
    const sharedHashDir = path.join(SHARED_OCR_DIR, hash);
    fs.mkdirSync(sharedHashDir, { recursive: true });
    // Copy original image
    const srcImage = path.join(hashDir, `original.${ext}`);
    if (fs.existsSync(srcImage)) {
      fs.copyFileSync(srcImage, path.join(sharedHashDir, `original.${ext}`));
    }
    // Copy OCR text
    if (text) {
      fs.writeFileSync(path.join(sharedHashDir, 'ocr.txt'), text);
    }
    // Copy index to shared dir
    fs.copyFileSync(INDEX_PATH, path.join(SHARED_OCR_DIR, 'index.json'));
  } catch (err) {
    logger.warn(
      { err, hash: hash.slice(0, 12) },
      'Failed to sync OCR to shared workspace',
    );
  }

  return text;
}

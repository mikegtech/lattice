#!/usr/bin/env tsx
/**
 * Lattice Worker Generator
 *
 * Usage: pnpm generate:worker <worker-name>
 *
 * Example: pnpm generate:worker email-embedder
 *
 * This will create a new NestJS Kafka worker at apps/workers/<worker-name>/
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const WORKERS_DIR = path.resolve(__dirname, '../../../apps/workers');

interface WorkerConfig {
  name: string;
  pascalName: string;
  camelName: string;
  kebabName: string;
  inputTopic: string;
  outputTopic: string;
  dlqTopic: string;
}

function toPascalCase(str: string): string {
  return str
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function processTemplate(template: string, config: WorkerConfig): string {
  return template
    .replace(/\{\{name\}\}/g, config.name)
    .replace(/\{\{pascalName\}\}/g, config.pascalName)
    .replace(/\{\{camelName\}\}/g, config.camelName)
    .replace(/\{\{kebabName\}\}/g, config.kebabName)
    .replace(/\{\{inputTopic\}\}/g, config.inputTopic)
    .replace(/\{\{outputTopic\}\}/g, config.outputTopic)
    .replace(/\{\{dlqTopic\}\}/g, config.dlqTopic);
}

async function generateWorker(name: string): Promise<void> {
  const workerDir = path.join(WORKERS_DIR, name);

  // Check if worker already exists
  try {
    await fs.access(workerDir);
    console.error(`Error: Worker '${name}' already exists at ${workerDir}`);
    process.exit(1);
  } catch {
    // Directory doesn't exist, continue
  }

  const config: WorkerConfig = {
    name,
    pascalName: toPascalCase(name),
    camelName: toCamelCase(name),
    kebabName: name,
    inputTopic: `lattice.${name.split('-')[0]}.input.v1`,
    outputTopic: `lattice.${name.split('-')[0]}.output.v1`,
    dlqTopic: `lattice.${name.split('-')[0]}.input.v1.dlq`,
  };

  console.log(`Generating worker: ${name}`);
  console.log(`  Pascal case: ${config.pascalName}`);
  console.log(`  Camel case: ${config.camelName}`);
  console.log(`  Input topic: ${config.inputTopic}`);
  console.log(`  Output topic: ${config.outputTopic}`);
  console.log('');

  // Create directory structure
  const dirs = [
    workerDir,
    path.join(workerDir, 'src'),
    path.join(workerDir, 'src', 'db'),
    path.join(workerDir, 'src', 'worker'),
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Read and process templates
  const templates = await fs.readdir(TEMPLATES_DIR);

  for (const template of templates) {
    const templatePath = path.join(TEMPLATES_DIR, template);
    const content = await fs.readFile(templatePath, 'utf-8');
    const processed = processTemplate(content, config);

    // Determine output path
    let outputPath: string;
    if (template.endsWith('.template')) {
      const filename = template.replace('.template', '');
      if (filename.startsWith('src-')) {
        // src-main.ts.template -> src/main.ts
        const srcPath = filename.replace('src-', '').replace(/-/g, '/');
        outputPath = path.join(workerDir, 'src', srcPath.replace(/\//g, path.sep));
      } else {
        outputPath = path.join(workerDir, filename);
      }
    } else {
      outputPath = path.join(workerDir, template);
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, processed);
    console.log(`  Created: ${path.relative(workerDir, outputPath)}`);
  }

  console.log('');
  console.log(`Worker '${name}' generated successfully!`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. cd apps/workers/${name}`);
  console.log('  2. Update .env.example with correct Kafka topics');
  console.log('  3. Define input/output types in src/worker/worker.types.ts');
  console.log('  4. Implement processing logic in src/worker/worker.service.ts');
  console.log('  5. Run: pnpm install && pnpm dev');
}

// Main
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log('Lattice Worker Generator');
  console.log('');
  console.log('Usage: pnpm generate:worker <worker-name>');
  console.log('');
  console.log('Arguments:');
  console.log('  worker-name  Name of the worker (kebab-case, e.g., email-embedder)');
  console.log('');
  console.log('Example:');
  console.log('  pnpm generate:worker email-embedder');
  process.exit(0);
}

const workerName = args[0]!;

// Validate name
if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(workerName) || workerName.includes('--')) {
  console.error('Error: Worker name must be kebab-case (e.g., my-worker)');
  process.exit(1);
}

generateWorker(workerName).catch((err) => {
  console.error('Failed to generate worker:', err);
  process.exit(1);
});

import type { UserConfig } from 'tsdown'

const host: UserConfig = {
  name: 'dsh-ainvestor',
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['@deepseek-ai/cordis'],
  },
}

export default host

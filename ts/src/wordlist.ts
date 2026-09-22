import { promises as fs } from 'fs';
import * as path from 'path';

export interface WordList {
  addWord(word: string): Promise<void>;
  getWords(): Promise<string[]>;
}

export class FileWordList implements WordList {
  private readonly filename: string;
  private words?: Promise<string[]>;
  private separator = '';

  constructor(filename: string) {
    this.filename = filename;
  }

  async addWord(word: string): Promise<void> {
    const words = await this.getWords();
    await fs.appendFile(this.filename, `${this.separator}${word}\n`, { encoding: 'utf8' });
    this.separator = '';
    words.push(word);
  }

  async getWords(): Promise<string[]> {
    // The API is the sole writer; share the initial read and cache successful adds.
    return this.words ??= fs.readFile(path.resolve(this.filename), { encoding: 'utf8' })
      .then(data => {
        this.separator = data.length > 0 && !data.endsWith('\n') ? '\n' : '';
        return data.split(/\r?\n/).filter(Boolean);
      })
      .catch(err => {
        this.words = undefined;
        throw err;
      });
  }
}

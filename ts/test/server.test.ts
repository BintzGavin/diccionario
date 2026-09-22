import request from 'supertest';
import { afterEach, describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import { createServer } from '../src/server.js';
import { FileWordList, type WordList } from '../src/wordlist.js';

class FakeWordList implements WordList {
  constructor(private readonly words: string[], private readonly err: Error | null = null) {}

  async addWord(word: string): Promise<void> {
    this.words.push(word);
  }

  async getWords(): Promise<string[]> {
    if (this.err) {
      throw this.err;
    }
    return this.words;
  }
}

describe('GET /exists/:word', () => {
  it('word exists with exact match', async () => {
    const wl = new FakeWordList(['hola', 'adios']);
    const app = createServer(wl);

    const res = await request(app).get('/exists/hola');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true });
  });

  it('a prefix is not an exact word', async () => {
    const wl = new FakeWordList(['hola', 'adios']);
    const app = createServer(wl);

    const res = await request(app).get('/exists/ad');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false });
  });

  it('word does not exist', async () => {
    const wl = new FakeWordList(['hola', 'adios']);
    const app = createServer(wl);

    const res = await request(app).get('/exists/bonjour');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false });
  });

  it('empty word list', async () => {
    const wl = new FakeWordList([]);
    const app = createServer(wl);

    const res = await request(app).get('/exists/hola');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false });
  });

  it('GetWords returns error', async () => {
    const wl = new FakeWordList([], new Error('boom'));
    const app = createServer(wl);

    const res = await request(app).get('/exists/hola');

    expect(res.status).toBe(500);
    expect(res.text).toBe('boom');
  });
});

it('matches whole words case-insensitively', async () => {
  const app = createServer(new FakeWordList(['HoLa', 'adios']));

  expect((await request(app).get('/exists/hOlA')).body).toEqual({ exists: true });
  expect((await request(app).get('/exists/holas')).body).toEqual({ exists: false });
});

it('matches prefixes case-insensitively, preserving word order and spelling', async () => {
  const app = createServer(new FakeWordList(['honey', 'HoLa', 'adios', 'holas']));

  const res = await request(app).get('/matches/Ho');

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ matches: ['honey', 'HoLa', 'holas'] });
  expect((await request(app).get('/matches/xyz')).body).toEqual({ matches: [] });
});

it.each(['exists', 'matches'])('rejects non-letter input to /%s', async (route) => {
  const app = createServer(new FakeWordList([]));

  for (const word of ['word1', '\u212a']) {
    expect((await request(app).get(`/${route}/${encodeURIComponent(word)}`)).status).toBe(400);
  }
});

it.each(['', 'two words', 'abc123', 'hello!', 'caf\u00e9', 'word\n', 1, null, [], {}].map(word => [word]))(
  'rejects invalid added word %j', async (word) => {
    const app = createServer(new FakeWordList([]));

    expect((await request(app).post('/add').send({ word })).status).toBe(400);
  }
);

it('rejects missing words and malformed JSON', async () => {
  const app = createServer(new FakeWordList([]));

  expect((await request(app).post('/add')).status).toBe(400);
  expect((await request(app).post('/add').send({})).status).toBe(400);
  expect((await request(app).post('/add').type('json').send('{')).status).toBe(400);
});

it('returns 500 for storage read and write errors', async () => {
  const app = createServer(new FakeWordList([], new Error('boom')));
  expect((await request(app).get('/matches/word')).status).toBe(500);
  expect((await request(app).post('/add').send({ word: 'word' })).status).toBe(500);

  const failingWriter = createServer({
    getWords: async () => [],
    addWord: async () => { throw new Error('write failed'); }
  });
  expect((await request(failingWriter).post('/add').send({ word: 'word' })).status).toBe(500);
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function wordFile(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'diccionario-'));
  directories.push(dir);
  const filename = path.join(dir, 'words.txt');
  await fs.writeFile(filename, contents);
  return filename;
}

it.each(['HoLa', 'HoLa\n', 'HoLa\r\n', ''])('persists additions with initial file %j', async (contents) => {
  const filename = await wordFile(contents);
  const app = createServer(new FileWordList(filename));
  await request(app).get('/matches/Ad');

  const added = await request(app).post('/add').send({ word: 'Adios' });
  expect(added.status).toBe(204);
  expect(added.text).toBe('');
  expect((await request(app).get('/exists/ADIOS')).body).toEqual({ exists: true });
  expect((await request(app).get('/matches/aD')).body).toEqual({ matches: ['Adios'] });
  expect((await request(app).post('/add').send({ word: 'adios' })).status).toBe(409);
  if (contents) {
    expect((await request(app).post('/add').send({ word: 'hOlA' })).status).toBe(409);
  }
  expect((await request(app).post('/add').send({ word: 'ad' })).status).toBe(204);

  const expected = contents ? ['HoLa', 'Adios', 'ad'] : ['Adios', 'ad'];
  expect(await new FileWordList(filename).getWords()).toEqual(expected);
});

it('rejects concurrent case-insensitive duplicates', async () => {
  const filename = await wordFile('');
  const app = createServer(new FileWordList(filename));
  const responses = await Promise.all(['hello', 'HELLO'].map((word) => request(app).post('/add').send({ word })));

  expect(responses.map((res) => res.status).sort()).toEqual([204, 409]);
  expect(await new FileWordList(filename).getWords()).toHaveLength(1);
});

it('does not expose failed writes and accepts later additions', async () => {
  const filename = await wordFile('hello\n');
  const app = createServer(new FileWordList(filename));
  await request(app).get('/exists/hello');
  await fs.unlink(filename);
  await fs.mkdir(filename);

  expect((await request(app).post('/add').send({ word: 'world' })).status).toBe(500);
  expect((await request(app).get('/exists/world')).body).toEqual({ exists: false });
  expect((await request(app).get('/matches/wo')).body).toEqual({ matches: [] });

  await fs.rmdir(filename);
  await fs.writeFile(filename, 'hello\n');
  expect((await request(app).post('/add').send({ word: 'world' })).status).toBe(204);
  expect(await new FileWordList(filename).getWords()).toEqual(['hello', 'world']);
});

it('includes words beyond the first 100,000 lines', async () => {
  const filename = await wordFile('alpha\n'.repeat(100000) + 'Zebra\n');
  const app = createServer(new FileWordList(filename));

  expect((await request(app).get('/exists/zebra')).body).toEqual({ exists: true });
  expect((await request(app).get('/matches/ZE')).body).toEqual({ matches: ['Zebra'] });
});

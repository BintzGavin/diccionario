import express, { Request, Response } from 'express';
import { FileWordList, WordList } from './wordlist.js';

export interface ExistsResponse {
  exists: boolean;
}

export interface MatchesResponse {
  matches: string[];
}

export interface AddRequest {
  word: string;
}

export class Server {
  readonly app = express();
  private readonly w: WordList;
  private pendingAdd = Promise.resolve();

  constructor(wordList?: WordList) {
    this.w = wordList ?? new FileWordList('/words.txt');

    this.app.use(express.json());

    this.app.get('/ping', (_req: Request, res: Response) => {
      res.status(200).json({ message: 'pong' });
    });

    this.app.get('/exists/:word', this.wordExists.bind(this));
    this.app.post('/add', this.add.bind(this));
    this.app.get('/matches/:prefix', this.matches.bind(this));
  }

  // Returns true if the word exists in the word list.
  // It performs case insensitive matching to the words in the wordlist.
  private async wordExists(req: Request, res: Response): Promise<void> {
    const word = req.params.word.toLowerCase();
    if (!/^[a-z]+$/i.test(req.params.word)) {
      res.status(400).send('invalid word');
      return;
    }

    let wordlist: string[];
    try {
      wordlist = await this.w.getWords();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).send(msg);
      return;
    }

    const resp: ExistsResponse = { exists: wordlist.some(w => w.toLowerCase() === word) };

    res.status(200).json(resp);
  }

  // Returns a list of words that matched the given prefix.
  // It performs case insensitive matching to the words in the wordlist.
  private async matches(req: Request, res: Response): Promise<void> {
    const prefix = req.params.prefix.toLowerCase();
    if (!/^[a-z]+$/i.test(req.params.prefix)) {
      res.status(400).send('invalid prefix');
      return;
    }

    let wordlist: string[];
    try {
      wordlist = await this.w.getWords();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).send(msg);
      return;
    }

    const resp: MatchesResponse = { matches: [] };

    for (const w of wordlist) {
      if (w.toLowerCase().startsWith(prefix)) {
        resp.matches.push(w);
      }
    }

    res.status(200).json(resp);
  }

  // Add a new word to the word list.
  private async add(req: Request, res: Response): Promise<void> {
    let body: AddRequest;
    try {
      body = req.body as AddRequest;
      if (typeof body?.word !== 'string' || !/^[a-z]+$/i.test(body.word)) {
        throw new Error('invalid body');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid body';
      res.status(400).send(msg);
      return;
    }

    // Keep duplicate checks and appends together, including concurrent requests.
    const addition = this.pendingAdd.then(async () => {
      const words = await this.w.getWords();
      if (words.some(w => w.toLowerCase() === body.word.toLowerCase())) {
        res.sendStatus(409);
        return;
      }
      await this.w.addWord(body.word);
      res.status(204).end();
    });
    this.pendingAdd = addition.catch(() => {});

    try {
      await addition;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).send(msg);
    }
  }
}

export function createServer(wordList?: WordList) {
  const server = new Server(wordList);
  return server.app;
}

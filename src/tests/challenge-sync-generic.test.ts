import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function run(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bksec-sync-generic-'));
  process.env.DB_PATH = path.join(directory, 'test.db');
  process.env.SERVER_ID = '100000000000000001';
  process.env.BOT_TOKEN = 'test-token';
  process.env.VIEW_ALL_CTF_ROLEID = '100000000000000002';
  process.env.ACTIVE_CTF_ROLEID = '100000000000000003';
  process.env.ADMIN_ROLE_ID = '100000000000000004';

  const challengeSyncService = (await import('../services/challenge-sync.service')).default as
    | {
        parseGenericJSON(
          data: unknown,
          baseURL: URL,
          fallbackSeed: string
        ): Array<{ name: string; category: string; points: number; externalId: string }>;
        parseEmbeddedJSON(html: string, baseURL: URL): Array<{ name: string; category: string }>;
        parseGenericJavaScript(
          script: string,
          baseURL: URL,
          fallbackSeed: string
        ): Array<{ name: string; category: string; points: number; externalId: string }>;
        parseRuleJSON(
          data: unknown,
          endpoint: URL,
          rule: {
            kind?: 'data';
            arrayPath: string;
            fields: {
              id?: string;
              name: string;
              category?: string;
              points?: string;
              description?: string;
              files?: string;
              fileName?: string;
              fileUrl?: string;
            };
          }
        ): Array<{ name: string; category: string; points: number; externalId: string }>;
        parseRuleHTML(
          html: string,
          endpoint: URL,
          rule: {
            kind: 'html';
            endpoint: string;
            arrayPath: string;
            fields: { name: string };
            html?: {
              categoryHeadings?: string[];
              hrefIncludes?: string[];
              defaultCategory?: string;
            };
          }
        ): Array<{ name: string; category: string; points: number; externalId: string }>;
        parseLLMChallenges(
          value: string,
          baseURL: URL
        ): Array<{ name: string; category: string; points: number; externalId: string }>;
      }
    | undefined;
  const databaseService = (await import('../services/database.service')).default;

  try {
    assert.ok(challengeSyncService);
    const baseURL = new URL('https://ctf.example/challenges');
    const fromJson = challengeSyncService.parseGenericJSON(
      {
        props: {
          pageProps: {
            challenges: [
              {
                id: 101,
                title: 'baby-web',
                category: { name: 'web' },
                value: '100 pts',
                description: 'Inspect the login flow.',
              },
            ],
          },
        },
      },
      baseURL,
      baseURL.toString()
    );
    assert.equal(fromJson.length, 1);
    assert.equal(fromJson[0].name, 'baby-web');
    assert.equal(fromJson[0].category, 'web');
    assert.equal(fromJson[0].points, 100);
    assert.equal(fromJson[0].externalId, '101');

    const html = `
      <html>
        <script id="__NEXT_DATA__" type="application/json">
          {"props":{"pageProps":{"challenges":[{"slug":"rev-1","name":"rev warmup","category":"rev"}]}}}
        </script>
      </html>
    `;
    const fromEmbeddedJson = challengeSyncService.parseEmbeddedJSON(html, baseURL);
    assert.equal(fromEmbeddedJson.length, 1);
    assert.equal(fromEmbeddedJson[0].name, 'rev warmup');
    assert.equal(fromEmbeddedJson[0].category, 'rev');

    const fromJavaScript = challengeSyncService.parseGenericJavaScript(
      'window.V1T_DATA = {"scoreboard":[{"id":1,"name":"not a chall","score":1}],"challenges":[{"id":7,"name":"B1tsy Ducky","category":"Web","value":100,"descriptionHtml":"<p>Play it</p>","files":[{"name":"src.zip","url":"files/src.zip"}]}]};',
      new URL('https://ctf.example/assets/data.js'),
      'https://ctf.example/assets/data.js'
    );
    assert.equal(fromJavaScript.length, 1);
    assert.equal(fromJavaScript[0].externalId, '7');
    assert.equal(fromJavaScript[0].name, 'B1tsy Ducky');
    assert.equal(fromJavaScript[0].category, 'web');
    assert.equal(fromJavaScript[0].points, 100);

    const fromRule = challengeSyncService.parseRuleJSON(
      {
        kind: 'goodChallenges',
        data: [
          {
            uuid: 'abc',
            title: 'Rule Me',
            section: 'crypto',
            score_now: 321,
            body: 'Use the parser recipe.',
            attachments: [{ label: 'handout.zip', href: '/files/handout.zip' }],
          },
        ],
      },
      new URL('https://ctf.example/api/v1/weird'),
      {
        arrayPath: 'data',
        fields: {
          id: 'uuid',
          name: 'title',
          category: 'section',
          points: 'score_now',
          description: 'body',
          files: 'attachments',
          fileName: 'label',
          fileUrl: 'href',
        },
      }
    );
    assert.equal(fromRule.length, 1);
    assert.equal(fromRule[0].externalId, 'abc');
    assert.equal(fromRule[0].name, 'Rule Me');
    assert.equal(fromRule[0].category, 'crypto');
    assert.equal(fromRule[0].points, 321);

    const htmlRule = {
      kind: 'html' as const,
      endpoint: 'https://ctf.example/ctfs/demo/challenges',
      arrayPath: '',
      fields: { name: '' },
      html: {
        categoryHeadings: ['Misc', 'Rev'],
        hrefIncludes: ['/challenges/'],
      },
    };
    const fromHTMLRule = challengeSyncService.parseRuleHTML(
      `
        <main>
          <h5>Misc</h5>
          <a href="/ctfs/demo/challenges/welcome">
            <div>Welcome</div>
            <span>81 pts (165 solves)</span>
            <p>by</p><a href="/users/author">author</a>
          </a>
          <a href="/users/not-a-challenge"><span>author</span></a>
          <h5>Rev</h5>
          <a href="/ctfs/demo/challenges/readme-pdf">
            <div>README.pdf</div>
            <span>88 pts (135 solves)</span>
          </a>
        </main>
      `,
      new URL(htmlRule.endpoint),
      htmlRule
    );
    assert.equal(fromHTMLRule.length, 2);
    assert.equal(fromHTMLRule[0].externalId, 'welcome');
    assert.equal(fromHTMLRule[0].name, 'Welcome');
    assert.equal(fromHTMLRule[0].category, 'misc');
    assert.equal(fromHTMLRule[0].points, 81);
    assert.equal(fromHTMLRule[1].externalId, 'readme-pdf');
    assert.equal(fromHTMLRule[1].name, 'README.pdf');
    assert.equal(fromHTMLRule[1].category, 'rev');
    assert.equal(fromHTMLRule[1].points, 88);

    const fromLLMExtraction = challengeSyncService.parseLLMChallenges(
      JSON.stringify({
        challenges: [
          {
            id: 'strange-web',
            name: 'Strange Web',
            category: 'web',
            points: '250 pts',
            url: '/challenges/strange-web',
          },
          {
            id: 'not-a-challenge-user',
            name: 'by',
            category: 'users',
            points: 0,
          },
        ],
      }),
      baseURL
    );
    assert.equal(fromLLMExtraction.length, 1);
    assert.equal(fromLLMExtraction[0].externalId, 'strange-web');
    assert.equal(fromLLMExtraction[0].name, 'Strange Web');
    assert.equal(fromLLMExtraction[0].category, 'web');
    assert.equal(fromLLMExtraction[0].points, 250);

    console.log('challenge sync generic tests passed');
  } finally {
    databaseService.close();
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

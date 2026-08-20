/**
 * Test suite for input parsing functions
 */

import { Keypair } from 'stellar-sdk';

import {
  parseCSV,
  parseInput,
  parseJSON,
  parsePaymentFile,
  parseFileStream,
} from '../lib/stellar/parser';

const validAddress = Keypair.random().publicKey();
const invalidChecksumAddress = `${validAddress.slice(0, -1)}${validAddress.endsWith('A') ? 'B' : 'A'}`;

class FakeFileReaderSync {
  readAsText(blob: any, encoding?: string): string {
    return blob._testContent || '';
  }
}
if (typeof globalThis !== 'undefined' && !(globalThis as any).FileReaderSync) {
  (globalThis as any).FileReaderSync = FakeFileReaderSync;

  const originalSlice = Blob.prototype.slice;
  Blob.prototype.slice = function(this: any, start?: number, end?: number, contentType?: string) {
    const sliced = originalSlice.call(this, start, end, contentType) as any;
    if (this._testContent !== undefined) {
      sliced._testContent = this._testContent.slice(start, end);
    }
    return sliced;
  };
}

describe('JSON Parser', () => {
  test('parses valid JSON array', () => {
    const json = JSON.stringify([
      {
        address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '100',
        asset: 'XLM',
      },
    ]);
    const result = parseJSON(json);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe('100');
  });

  test('parses JSON object with payments property', () => {
    const json = JSON.stringify({
      payments: [
        {
          address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
          amount: '100',
          asset: 'XLM',
        },
      ],
    });
    const result = parseJSON(json);
    expect(result).toHaveLength(1);
  });

  test('throws on invalid JSON', () => {
    expect(() => parseJSON('invalid json')).toThrow();
  });

  test('throws on JSON without payments', () => {
    const json = JSON.stringify({ data: [] });
    expect(() => parseJSON(json)).toThrow();
  });

  test('preserves amount as string', () => {
    const json = JSON.stringify([
      {
        address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '123.456789',
        asset: 'XLM',
      },
    ]);
    const result = parseJSON(json);
    expect(result[0].amount).toBe('123.456789');
  });

  // #714: Reject numeric JSON amounts to prevent silent IEEE-754 rounding
  test('rejects unquoted numeric amount that would round silently', () => {
    // Using raw JSON string so the amount is a literal number, not a string
    const json = `[{"address":"GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER","amount":99999999999.9999999,"asset":"XLM"}]`;
    expect(() => parseJSON(json)).toThrow(/amount must be a quoted string/);
  });

  test('rejects unquoted small numeric amount that becomes scientific notation', () => {
    const json = `[{"address":"GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER","amount":0.0000001,"asset":"XLM"}]`;
    expect(() => parseJSON(json)).toThrow(/amount must be a quoted string/);
  });

  test('rejects unquoted integer amount', () => {
    const json = `[{"address":"GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER","amount":100,"asset":"XLM"}]`;
    expect(() => parseJSON(json)).toThrow(/amount must be a quoted string/);
  });

  test('accepts quoted string amount for large value', () => {
    const json = `[{"address":"GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER","amount":"99999999999.9999999","asset":"XLM"}]`;
    const result = parseJSON(json);
    expect(result[0].amount).toBe('99999999999.9999999');
  });

  test('accepts quoted string amount for tiny value', () => {
    const json = `[{"address":"GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER","amount":"0.0000001","asset":"XLM"}]`;
    const result = parseJSON(json);
    expect(result[0].amount).toBe('0.0000001');
  });
});

describe('CSV Parser', () => {
  test('parses valid CSV', () => {
    const csv = `address,amount,asset
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,100,XLM`;
    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe('100');
  });

  test('parses CSV with multiple rows', () => {
    const csv = `address,amount,asset
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,100,XLM
GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67,50,XLM`;
    const result = parseCSV(csv);
    expect(result).toHaveLength(2);
  });

  test('handles whitespace in CSV', () => {
    const csv = `address, amount, asset
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER, 100, XLM`;
    const result = parseCSV(csv);
    expect(result[0].amount).toBe('100');
  });

  test('skips empty lines', () => {
    const csv = `address,amount,asset
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,100,XLM

GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67,50,XLM`;
    const result = parseCSV(csv);
    expect(result).toHaveLength(2);
  });

  test('throws without required columns', () => {
    const csv = `address,amount
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,100`;
    expect(() => parseCSV(csv)).toThrow();
  });

  test('throws on empty data', () => {
    const csv = 'address,amount,asset\n';
    expect(() => parseCSV(csv)).toThrow();
  });
});

describe('Format Detection', () => {
  test('parses JSON format', () => {
    const json = JSON.stringify([
      {
        address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '100',
        asset: 'XLM',
      },
    ]);
    const result = parseInput(json, 'json');
    expect(result).toHaveLength(1);
  });

  test('parses CSV format', () => {
    const csv = `address,amount,asset
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,100,XLM`;
    const result = parseInput(csv, 'csv');
    expect(result).toHaveLength(1);
  });

  test('throws on unknown format', () => {
    expect(() => parseInput('data', 'xml' as any)).toThrow();
  });
});

describe('Memo Parsing - JSON', () => {
  test('parses JSON with memo fields', () => {
    const json = JSON.stringify([
      {
        address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '100',
        asset: 'XLM',
        memo: 'Test payment',
        memoType: 'text',
      },
    ]);
    const result = parseJSON(json);
    expect(result[0].memo).toBe('Test payment');
    expect(result[0].memoType).toBe('text');
  });

  test('parses JSON with ID memo type', () => {
    const json = JSON.stringify([
      {
        address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '100',
        asset: 'XLM',
        memo: '12345',
        memoType: 'id',
      },
    ]);
    const result = parseJSON(json);
    expect(result[0].memo).toBe('12345');
    expect(result[0].memoType).toBe('id');
  });

  test('parses JSON without memo fields', () => {
    const json = JSON.stringify([
      {
        address: 'GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER',
        amount: '100',
        asset: 'XLM',
      },
    ]);
    const result = parseJSON(json);
    expect(result[0].memo).toBeUndefined();
    expect(result[0].memoType).toBeUndefined();
  });
});

describe('Memo Parsing - CSV', () => {
  test('parses CSV with memo column', () => {
    const csv = `address,amount,asset,memo,memoType
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,100,XLM,Test payment,text`;
    const result = parseCSV(csv);
    expect(result[0].memo).toBe('Test payment');
    expect(result[0].memoType).toBe('text');
  });

  test('parses CSV with ID memo type', () => {
    const csv = `address,amount,asset,memo,memoType
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,100,XLM,67890,id`;
    const result = parseCSV(csv);
    expect(result[0].memo).toBe('67890');
    expect(result[0].memoType).toBe('id');
  });

  test('parses CSV without memo column', () => {
    const csv = `address,amount,asset
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,100,XLM`;
    const result = parseCSV(csv);
    expect(result[0].memo).toBeUndefined();
  });

  test('handles empty memo in CSV row', () => {
    const csv = `address,amount,asset,memo,memoType
GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER,100,XLM,,`;
    const result = parseCSV(csv);
    expect(result[0].memo).toBeUndefined();
  });
});

describe('Payment File Analysis', () => {
  test('returns row-level validation feedback for invalid CSV rows', () => {
    const csv = `address,amount,asset
${validAddress},100,XLM
${invalidChecksumAddress},25,XLM
,30,XLM`;

    const result = parsePaymentFile(csv, 'csv');

    expect(result.rows).toHaveLength(3);
    expect(result.validPayments).toHaveLength(1);
    expect(result.invalidCount).toBe(2);
    expect(result.rows[1].rowNumber).toBe(3);
    expect(result.rows[1].error).toContain('checksum');
    expect(result.rows[2].error).toContain('address');
  });
});

describe('parseFileStream', () => {
  test('attaches correct rowIndex to streamed valid payment instructions', () => {
    const csvContent = `address,amount,asset
${validAddress},100,XLM
${validAddress},200,XLM`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' }) as any;
    file._testContent = csvContent;

    return new Promise<void>((resolve, reject) => {
      parseFileStream(file, {
        onComplete: (result) => {
          try {
            expect(result.payments).toHaveLength(2);
            expect(result.errors).toHaveLength(0);
            
            // Check that rowIndex is correct (0-based)
            expect(result.payments[0].rowIndex).toBe(0);
            expect(result.payments[0].amount).toBe('100');
            expect(result.payments[1].rowIndex).toBe(1);
            expect(result.payments[1].amount).toBe('200');
            
            resolve();
          } catch (e) {
            reject(e);
          }
        },
        onError: (err) => {
          reject(err);
        },
      });
    });
  });

  test('reports errors with absolute row indices starting at 2 (parity with parsePaymentFile)', () => {
    const csvContent = `address,amount,asset
${validAddress},100,XLM
${invalidChecksumAddress},50,XLM
${validAddress},200,XLM`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' }) as any;
    file._testContent = csvContent;

    return new Promise<void>((resolve, reject) => {
      parseFileStream(file, {
        onComplete: (result) => {
          try {
            expect(result.payments).toHaveLength(2);
            expect(result.errors).toHaveLength(1);
            
            // First valid payment
            expect(result.payments[0].rowIndex).toBe(0);
            expect(result.payments[0].amount).toBe('100');
            
            // Second valid payment (originally row 3 of data, index 2)
            expect(result.payments[1].rowIndex).toBe(2);
            expect(result.payments[1].amount).toBe('200');
            
            // Validation error on row 3 (data index 1, absolute row 3)
            expect(result.errors[0].row).toBe(3);
            expect(result.errors[0].message).toContain('Row 3');
            
            resolve();
          } catch (e) {
            reject(e);
          }
        },
        onError: (err) => {
          reject(err);
        },
      });
    });
  });
});

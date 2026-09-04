import { describe, expect, it } from 'vitest';
import { serializeServerProperties } from '../src/props';

describe('serializeServerProperties', () => {
  it('quotes values containing spaces', () => {
    const out = serializeServerProperties({
      motd: { value: 'A PurpleMC Server', comment: '', raw: 'motd=...' }
    });
    expect(out).toBe('motd="A PurpleMC Server"');
  });

  it('re-emits preserved comments above the key', () => {
    const out = serializeServerProperties({
      online: { value: 'true', comment: '# Whether to check auth', raw: 'online=true' }
    });
    expect(out).toBe('# Whether to check auth\nonline=true');
  });

  it('does not quote plain values', () => {
    const out = serializeServerProperties({
      port: { value: '25565', comment: '', raw: 'port=25565' }
    });
    expect(out).toBe('port=25565');
  });
});

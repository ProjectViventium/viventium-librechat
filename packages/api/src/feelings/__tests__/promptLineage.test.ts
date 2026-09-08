import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { buildFeelingCapsule, createDefaultFeelingBands, FEELING_BANDS } from '../kernel';
import { getFeelingPromptPolicy } from '../promptPolicy';
import * as feelingTypes from '../types';
import { feelingPromptBundle } from './promptBundle.helper';
import { clearFeelingsReadCache, loadFeelingsReadContext } from '../service';

describe('Feeling compiled prompt lineage', () => {
  let fixture: ReturnType<typeof feelingPromptBundle>;
  beforeEach(() => {
    fixture = feelingPromptBundle();
  });
  afterEach(() => {
    clearFeelingsReadCache();
    fixture?.close();
  });

  it('keeps level instructions lazy through the production TypeScript target', () => {
    const configPath = path.resolve(__dirname, '../../../tsconfig.build.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const { options } = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      path.dirname(configPath),
    );
    const compiled = ts.transpileModule(
      fs.readFileSync(path.join(__dirname, '../kernel.ts'), 'utf8'),
      {
        compilerOptions: { ...options, module: ts.ModuleKind.CommonJS },
      },
    );
    const module = { exports: {} as typeof import('../kernel') };
    delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
    runInNewContext(compiled.outputText, {
      module,
      exports: module.exports,
      require: (id: string) => {
        if (id === './promptPolicy') return { getFeelingPromptPolicy };
        if (id === './types') return feelingTypes;
        if (id === 'node:crypto') return { createHash };
        throw new Error(`Unexpected compiled kernel dependency: ${id}`);
      },
    });
    const level = module.exports.FEELING_BANDS[0].levels[2];
    expect(Object.getOwnPropertyDescriptor(level, 'instruction')?.get).toEqual(
      expect.any(Function),
    );
    process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = fixture.bundle;
    const original = level.instruction;
    const source = path.join(fixture.sources, 'feelings/capsule_policy.md');
    const edited = 'Synthetic compiled-target instruction update.';
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace(original, edited));
    fixture.compile();
    expect(level.instruction).toBe(edited);
  });

  it.each([
    ['defaults', '15b1e54b1a3187391a160d6d26fcae0379b8100a735745c5d812a3790d86aaf1'],
    ['low', 'a4676b8e70a0ffa22b521abf4ab1209f935b40ef71f03ee77ae8cbf6b4e1710f'],
    ['high', 'f410ae9b0424871136b131c3f0335f977005eafe14a6fd62e8ce4add1f7c3c51'],
    ['neutral', '155cb1aedbb82d9aefbf003ad19f7fb485fb0b274ff6dd15950899b17499dfa5'],
    ['moderate', 'a903c43dd6de32027edc998a81a450e28f71070d198a98565968366ad30247f0'],
    ['mixed', 'cc0a24adfd3298319e12352e78d769d13697ddbf1fcbacf98ee68f3066107fad'],
    ['custom', '596d16ae6008038910cd52bd08a4272b479dce3e8c2d96c48cd09fb6946ec843'],
  ])('preserves the recorded %s capsule bytes', (name, expectedHash) => {
    const bands = createDefaultFeelingBands(new Date(0));
    const uniform = ({ low: 0, high: 100, neutral: 50, moderate: 70 } as Record<string, number>)[
      name
    ];
    if (uniform !== undefined) for (const band of Object.values(bands)) band.current = uniform;
    if (name === 'mixed' || name === 'custom') {
      FEELING_BANDS.forEach((band, index) => {
        bands[band.id].current = [0, 100, 35, 75, 81, 19, 60, 45, 98][index];
      });
    }
    const capsule = buildFeelingCapsule({
      enabled: true,
      bands,
      rangePromptOverrides:
        name === 'custom' ? { play: { level_4: 'Keep the supplied table exact.' } } : {},
    });
    expect(createHash('sha256').update(capsule).digest('hex')).toBe(expectedHash);
  });

  it('uses an edited source after compile without reloading the kernel', () => {
    const bands = createDefaultFeelingBands(new Date(0));
    const original = buildFeelingCapsule({ enabled: true, bands });
    const source = path.join(fixture.sources, 'feelings/capsule_policy.md');
    const oldText = 'I have enough energy for a steady, unforced pace.';
    const nextText = 'Synthetic source edit keeps the current energy state.';
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace(oldText, nextText));
    expect(buildFeelingCapsule({ enabled: true, bands })).toBe(original);
    fixture.compile();
    expect(buildFeelingCapsule({ enabled: true, bands })).toBe(original.replace(oldText, nextText));
    expect(FEELING_BANDS[0].levels[2].instruction).toBe(nextText);
  });

  it('does not silently restore an inline capsule when the compiled source is unavailable', () => {
    fs.unlinkSync(fixture.bundle);
    expect(() =>
      buildFeelingCapsule({ enabled: true, bands: createDefaultFeelingBands(new Date(0)) }),
    ).toThrow('prompt_bundle_unavailable');
    expect(
      buildFeelingCapsule({ enabled: false, bands: createDefaultFeelingBands(new Date(0)) }),
    ).toBe('');
  });

  it('refreshes a cached state after compile while preserving the already pinned capsule', async () => {
    const options = {
      userId: 'feeling-source-owner',
      getFeelingState: async () => ({ enabled: true }),
      now: new Date(0),
    };
    const first = await loadFeelingsReadContext(options);
    const source = path.join(fixture.sources, 'feelings/capsule_policy.md');
    const oldText = 'I have enough energy for a steady, unforced pace.';
    const nextText = 'Synthetic edited energy cause.';
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace(oldText, nextText));
    fixture.compile();
    const next = await loadFeelingsReadContext(options);
    expect(next.capsule).toBe(first.capsule.replace(oldText, nextText));
    expect(first.capsule).toContain(oldText);
    expect(next.bands).toEqual(first.bands);
    expect(next.snapshotHash).toBe(first.snapshotHash);
  });

  it('rejects a compiled policy missing a required level instead of retaining old semantics', () => {
    buildFeelingCapsule({ enabled: true, bands: createDefaultFeelingBands(new Date(0)) });
    const bundle = JSON.parse(fs.readFileSync(fixture.bundle, 'utf8'));
    const policy = JSON.parse(bundle.prompts['feelings.capsule_policy'].body);
    delete policy.levels.energy.level_2;
    bundle.prompts['feelings.capsule_policy'].body = JSON.stringify(policy);
    fs.writeFileSync(fixture.bundle, JSON.stringify(bundle));
    expect(() =>
      buildFeelingCapsule({ enabled: true, bands: createDefaultFeelingBands(new Date(0)) }),
    ).toThrow('Feeling prompt policy is missing a level');
  });
});

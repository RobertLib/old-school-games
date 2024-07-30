import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/**
 * Exercise the installed default worklet, including the program its loader
 * actually registers. The former test covered the forced ScriptProcessor
 * fallback; that would miss music altered by the default worklet on upgrade.
 */
const sourceMap = JSON.parse(
  readFileSync(
    new URL("../../node_modules/js-dos/dist/emulators/emulators.js.map", import.meta.url),
    "utf8",
  ),
) as { sources: string[]; sourcesContent: string[] };
const sourceIndex = sourceMap.sources.findIndex((source) =>
  source.endsWith("/audio-worklet.ts"),
);
if (sourceIndex < 0) throw new Error("The installed js-dos worklet has moved");
const audioCode = ts.transpileModule(sourceMap.sourcesContent[sourceIndex]!, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Processor = {
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
};

async function loadAudio() {
  const port = {
    onmessage: null as null | ((event: { data: Float32Array }) => void),
  };
  let processor: Processor;
  let program = "";
  const contexts = vi.fn();
  const nodes = vi.fn();
  const addModule = vi.fn(async () => {});
  const connect = vi.fn();
  const exports: Record<string, any> = {};

  class AudioContext {
    sampleRate = 44100;
    state = "running";
    destination = {};
    audioWorklet = { addModule };

    constructor(options: unknown) {
      contexts(options);
    }
  }

  class AudioWorkletNode {
    port = port;
    connect = connect;

    constructor(context: AudioContext, name: string, options: unknown) {
      nodes(context, name, options);
      vm.runInNewContext(program, {
        Float32Array,
        AudioWorkletProcessor: class { port = port; },
        registerProcessor: (registeredName: string, Constructor: new () => Processor) => {
          expect(registeredName).toBe(name);
          processor = new Constructor();
        },
        console,
      });
    }
  }

  vm.runInNewContext(audioCode, {
    exports,
    AudioContext,
    AudioWorkletNode,
    Blob: class {
      constructor(parts: string[]) { program = parts.join(""); }
    },
    URL: { createObjectURL: () => "blob:js-dos-audio" },
    document: { addEventListener: vi.fn() },
    console,
  });
  expect(await exports.createAudioPort()).toBe(port);

  function render() {
    const output = new Float32Array(128);
    expect(processor.process([], [[output]])).toBe(true);
    return output;
  }

  // Audio rendering starts the upstream queue before the emulator sends PCM.
  render();
  return {
    push: (samples: Float32Array) => port.onmessage!({ data: samples }),
    render,
    contexts,
    nodes,
    addModule,
    connect,
  };
}

describe("js-dos default AudioWorklet", () => {
  it("preserves mixed tones and transients without changing tempo or crossfading", async () => {
    const audio = await loadAudio();
    const input = Float32Array.from({ length: 4096 }, (_, i) =>
      0.2 * Math.sin(2 * Math.PI * 440 * i / 44100) +
      0.2 * Math.sin(2 * Math.PI * 659.255 * i / 44100) +
      (i % 997 === 0 ? 0.3 : 0),
    );

    audio.push(input.slice(0, 733));
    audio.push(input.slice(733, 1757));
    audio.push(input.slice(1757));

    expect(audio.contexts).toHaveBeenCalledExactlyOnceWith({
      sampleRate: 44100,
      latencyHint: "interactive",
    });
    expect(audio.addModule).toHaveBeenCalledExactlyOnceWith("blob:js-dos-audio");
    expect(audio.nodes).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), "jsdos-audio", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      },
    );
    expect(audio.connect).toHaveBeenCalledOnce();
    for (let offset = 0; offset < input.length; offset += 128) {
      expect(audio.render()).toEqual(input.slice(offset, offset + 128));
    }
  });

  it("keeps consecutive render blocks unchanged as more chunks arrive", async () => {
    const audio = await loadAudio();
    const input = Float32Array.from({ length: 8192 }, (_, i) =>
      0.5 * Math.sin(2 * Math.PI * 523.25 * i / 44100),
    );

    for (let offset = 0; offset < input.length; offset += 512) {
      audio.push(input.slice(offset, offset + 193));
      expect(audio.render()).toEqual(input.slice(offset, offset + 128));
      audio.push(input.slice(offset + 193, offset + 512));
      for (let block = 128; block < 512; block += 128) {
        expect(audio.render()).toEqual(input.slice(offset + block, offset + block + 128));
      }
    }
  });

  it("fills missing samples with silence and resumes without altering incoming PCM", async () => {
    const audio = await loadAudio();
    const first = new Float32Array(193).fill(0.25);
    audio.push(first);
    expect(audio.render()).toEqual(first.slice(0, 128));
    expect(audio.render()).toEqual(new Float32Array([
      ...first.slice(128), ...new Float32Array(63),
    ]));
    expect(audio.render()).toEqual(new Float32Array(128));

    const next = new Float32Array(256).fill(-0.25);
    audio.push(next);
    expect(audio.render()).toEqual(next.slice(0, 128));
    expect(audio.render()).toEqual(next.slice(128));
  });
});

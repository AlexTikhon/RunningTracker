interface DecodedPoint {
  x: number;
  y: number;
}

export interface DecodedMvtFeature {
  geometry: DecodedPoint[][];
  properties: Record<string, string>;
  type: number;
}

export interface DecodedMvtLayer {
  extent: number;
  features: DecodedMvtFeature[];
  name: string;
}

class ProtobufReader {
  public offset = 0;

  public constructor(private readonly bytes: Buffer) {}

  public get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  public readVarint(): number {
    let result = 0;
    let shift = 0;
    while (shift <= 49) {
      const byte = this.bytes[this.offset];
      if (byte === undefined) {
        throw new Error('Unexpected end of MVT varint');
      }
      this.offset += 1;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) {
          throw new Error('MVT varint exceeds the safe integer range');
        }
        return result;
      }
      shift += 7;
    }
    throw new Error('MVT varint is too long');
  }

  public readLengthDelimited(): Buffer {
    const length = this.readVarint();
    const end = this.offset + length;
    if (end > this.bytes.length) {
      throw new Error('MVT length-delimited field exceeds its message');
    }
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  public skip(wireType: number): void {
    if (wireType === 0) {
      this.readVarint();
      return;
    }
    if (wireType === 1) {
      this.offset += 8;
      return;
    }
    if (wireType === 2) {
      this.readLengthDelimited();
      return;
    }
    if (wireType === 5) {
      this.offset += 4;
      return;
    }
    throw new Error(`Unsupported MVT wire type ${wireType}`);
  }
}

interface RawFeature {
  geometry: number[];
  tags: number[];
  type: number;
}

function readPackedVarints(bytes: Buffer): number[] {
  const reader = new ProtobufReader(bytes);
  const values: number[] = [];
  while (!reader.done) {
    values.push(reader.readVarint());
  }
  return values;
}

function decodeValue(bytes: Buffer): string {
  const reader = new ProtobufReader(bytes);
  while (!reader.done) {
    const tag = reader.readVarint();
    const field = tag >>> 3;
    const wireType = tag & 0x07;
    if (field === 1 && wireType === 2) {
      return reader.readLengthDelimited().toString('utf8');
    }
    reader.skip(wireType);
  }
  throw new Error('Expected an MVT string value');
}

function decodeFeature(bytes: Buffer): RawFeature {
  const reader = new ProtobufReader(bytes);
  const feature: RawFeature = { geometry: [], tags: [], type: 0 };
  while (!reader.done) {
    const tag = reader.readVarint();
    const field = tag >>> 3;
    const wireType = tag & 0x07;
    if (field === 2 && wireType === 2) {
      feature.tags.push(...readPackedVarints(reader.readLengthDelimited()));
    } else if (field === 3 && wireType === 0) {
      feature.type = reader.readVarint();
    } else if (field === 4 && wireType === 2) {
      feature.geometry.push(...readPackedVarints(reader.readLengthDelimited()));
    } else {
      reader.skip(wireType);
    }
  }
  return feature;
}

function zigZag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

function decodeLineGeometry(commands: number[]): DecodedPoint[][] {
  const lines: DecodedPoint[][] = [];
  let x = 0;
  let y = 0;
  let offset = 0;
  let currentLine: DecodedPoint[] | undefined;

  while (offset < commands.length) {
    const command = commands[offset];
    if (command === undefined) {
      throw new Error('Missing MVT geometry command');
    }
    offset += 1;
    const commandId = command & 0x07;
    const count = command >>> 3;
    if (commandId !== 1 && commandId !== 2) {
      throw new Error(`Unexpected command ${commandId} in line geometry`);
    }

    for (let index = 0; index < count; index += 1) {
      const encodedX = commands[offset];
      const encodedY = commands[offset + 1];
      if (encodedX === undefined || encodedY === undefined) {
        throw new Error('Incomplete MVT line coordinate');
      }
      offset += 2;
      x += zigZag(encodedX);
      y += zigZag(encodedY);
      if (commandId === 1) {
        currentLine = [];
        lines.push(currentLine);
      }
      if (!currentLine) {
        throw new Error('MVT line starts without MoveTo');
      }
      currentLine.push({ x, y });
    }
  }

  return lines;
}

function decodeLayer(bytes: Buffer): DecodedMvtLayer {
  const reader = new ProtobufReader(bytes);
  const keys: string[] = [];
  const values: string[] = [];
  const rawFeatures: RawFeature[] = [];
  let extent = 4096;
  let name = '';

  while (!reader.done) {
    const tag = reader.readVarint();
    const field = tag >>> 3;
    const wireType = tag & 0x07;
    if (field === 1 && wireType === 2) {
      name = reader.readLengthDelimited().toString('utf8');
    } else if (field === 2 && wireType === 2) {
      rawFeatures.push(decodeFeature(reader.readLengthDelimited()));
    } else if (field === 3 && wireType === 2) {
      keys.push(reader.readLengthDelimited().toString('utf8'));
    } else if (field === 4 && wireType === 2) {
      values.push(decodeValue(reader.readLengthDelimited()));
    } else if (field === 5 && wireType === 0) {
      extent = reader.readVarint();
    } else {
      reader.skip(wireType);
    }
  }

  return {
    extent,
    features: rawFeatures.map((feature) => {
      if (feature.tags.length % 2 !== 0) {
        throw new Error('MVT feature tags must contain key/value pairs');
      }
      const properties: Record<string, string> = {};
      for (let index = 0; index < feature.tags.length; index += 2) {
        const key = keys[feature.tags[index]!];
        const value = values[feature.tags[index + 1]!];
        if (key === undefined || value === undefined) {
          throw new Error('MVT feature references an unknown key or value');
        }
        properties[key] = value;
      }
      return {
        geometry: decodeLineGeometry(feature.geometry),
        properties,
        type: feature.type,
      };
    }),
    name,
  };
}

export function decodeMvt(bytes: Buffer): DecodedMvtLayer[] {
  const reader = new ProtobufReader(bytes);
  const layers: DecodedMvtLayer[] = [];
  while (!reader.done) {
    const tag = reader.readVarint();
    const field = tag >>> 3;
    const wireType = tag & 0x07;
    if (field === 3 && wireType === 2) {
      layers.push(decodeLayer(reader.readLengthDelimited()));
    } else {
      reader.skip(wireType);
    }
  }
  return layers;
}

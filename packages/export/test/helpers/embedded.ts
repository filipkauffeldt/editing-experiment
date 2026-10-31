import { readFile, writeFile } from 'node:fs/promises';

/** Inserts a metadata segment immediately after the JPEG SOI marker. */
export function withSegment(jpeg: Buffer, marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

function buildExifTiff(thumbnail: Buffer): Buffer {
  // Little-endian TIFF: header (8) -> IFD0 (6) -> IFD1 (30) -> thumbnail data.
  const tiff = Buffer.alloc(44 + thumbnail.length);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0

  // IFD0 with no entries, pointing at IFD1.
  tiff.writeUInt16LE(0, 8);
  tiff.writeUInt32LE(14, 10); // next IFD (IFD1)

  // IFD1: JPEGInterchangeFormat/JPEGInterchangeFormatLength.
  tiff.writeUInt16LE(2, 14);
  tiff.writeUInt16LE(0x0201, 16);
  tiff.writeUInt16LE(4, 18);
  tiff.writeUInt32LE(1, 20);
  tiff.writeUInt32LE(44, 24); // thumbnail offset

  tiff.writeUInt16LE(0x0202, 28);
  tiff.writeUInt16LE(4, 30);
  tiff.writeUInt32LE(1, 32);
  tiff.writeUInt32LE(thumbnail.length, 36);
  tiff.writeUInt32LE(0, 40); // no IFD2

  thumbnail.copy(tiff, 44);
  return tiff;
}

export function exifThumbnailSegment(thumbnail: Buffer): { marker: number; payload: Buffer } {
  return {
    marker: 0xe1,
    payload: Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), buildExifTiff(thumbnail)]),
  };
}

export function xmpThumbnailSegment(): { marker: number; payload: Buffer } {
  const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/">
      <xmp:Thumbnails>
        <rdf:Alt>
          <rdf:li rdf:parseType="Resource">
            <xmpGImg:image>/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////</xmpGImg:image>
          </rdf:li>
        </rdf:Alt>
      </xmp:Thumbnails>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  return {
    marker: 0xe1,
    payload: Buffer.concat([
      Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'),
      Buffer.from(xmp, 'utf8'),
    ]),
  };
}

export function photoshopThumbnailSegment(): { marker: number; payload: Buffer } {
  const block = Buffer.alloc(8);
  block.write('8BIM', 0, 'latin1');
  block.writeUInt16BE(0x0409, 4); // ThumbnailResource
  block[6] = 0; // empty Pascal name
  block[7] = 0; // pad to an even name field

  const thumbnailData = Buffer.alloc(28);
  thumbnailData.write('JPEG', 0, 'latin1'); // resource header; contents are not parsed

  const size = Buffer.alloc(4);
  size.writeUInt32BE(thumbnailData.length, 0);

  return {
    marker: 0xed,
    payload: Buffer.concat([
      Buffer.from('Photoshop 3.0\0', 'latin1'),
      block,
      size,
      thumbnailData,
      Buffer.alloc(thumbnailData.length % 2),
    ]),
  };
}

export async function addExifThumbnail(jpegPath: string, thumbnail: Buffer): Promise<void> {
  const original = await readFile(jpegPath);
  const segment = exifThumbnailSegment(thumbnail);
  await writeFile(jpegPath, withSegment(original, segment.marker, segment.payload));
}

export function insertExifThumbnail(jpeg: Buffer, thumbnail: Buffer): Buffer {
  const segment = exifThumbnailSegment(thumbnail);
  return withSegment(jpeg, segment.marker, segment.payload);
}

export function insertXmpThumbnail(jpeg: Buffer): Buffer {
  const segment = xmpThumbnailSegment();
  return withSegment(jpeg, segment.marker, segment.payload);
}

export function insertPhotoshopThumbnail(jpeg: Buffer): Buffer {
  const segment = photoshopThumbnailSegment();
  return withSegment(jpeg, segment.marker, segment.payload);
}

export function jfifThumbnailSegment(): { marker: number; payload: Buffer } {
  const thumbnailWidth = 8;
  const thumbnailHeight = 8;
  const payload = Buffer.alloc(14 + thumbnailWidth * thumbnailHeight * 3, 0x80);
  payload.write('JFIF\0', 0, 'latin1');
  payload[5] = 1; // version 1.1
  payload[6] = 1;
  payload[7] = 0; // units
  payload.writeUInt16BE(1, 8);
  payload.writeUInt16BE(1, 10);
  payload[12] = thumbnailWidth;
  payload[13] = thumbnailHeight;
  return { marker: 0xe0, payload };
}

export function jfxxThumbnailSegment(thumbnail: Buffer): { marker: number; payload: Buffer } {
  return {
    marker: 0xe0,
    payload: Buffer.concat([Buffer.from('JFXX\0', 'latin1'), Buffer.from([0x10]), thumbnail]),
  };
}

export function mpfSegment(): { marker: number; payload: Buffer } {
  return {
    marker: 0xe2,
    payload: Buffer.concat([
      Buffer.from('MPF\0', 'latin1'),
      // Minimal TIFF-ish payload; the scanner must reject the whole segment.
      Buffer.from('MM\0*\0\0\0\x08\0\0\0\0\0', 'latin1'),
    ]),
  };
}

export function xmpThumbnailUtf16Segment(): { marker: number; payload: Buffer } {
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/">
      <xmp:Thumbnails><rdf:Alt><rdf:li><xmpGImg:image>/9j/4AAQ</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
  return {
    marker: 0xe1,
    payload: Buffer.concat([
      Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(xml, 'utf16le'),
    ]),
  };
}

export function malformedExifSegment(kind: 'magic' | 'ifd'): { marker: number; payload: Buffer } {
  const tiff = Buffer.alloc(16);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(kind === 'magic' ? 41 : 42, 2);
  tiff.writeUInt32LE(kind === 'ifd' ? 9999 : 8, 4);
  tiff.writeUInt16LE(0, 8);
  tiff.writeUInt32LE(0, 10);
  return {
    marker: 0xe1,
    payload: Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]),
  };
}

export function malformedPhotoshopSegment(kind: 'signature' | 'truncated'): {
  marker: number;
  payload: Buffer;
} {
  if (kind === 'truncated') {
    return {
      marker: 0xed,
      payload: Buffer.concat([
        Buffer.from('Photoshop 3.0\0', 'latin1'),
        Buffer.from('8BIM', 'latin1'),
        Buffer.from([0x04, 0x04, 0x00]),
      ]),
    };
  }
  return {
    marker: 0xed,
    payload: Buffer.concat([
      Buffer.from('Photoshop 3.0\0', 'latin1'),
      Buffer.from('NOPE', 'latin1'),
      Buffer.alloc(12),
    ]),
  };
}

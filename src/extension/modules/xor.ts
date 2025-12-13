export function xorBuffer(data: Buffer, key: string): Buffer {
    const keyBuf = Buffer.from(key, "utf8");
    const out = Buffer.allocUnsafe(data.length);

    for (let i = 0; i < data.length; i++) {
        out[i] = data[i] ^ keyBuf[i % keyBuf.length];
    }

    return out;
}
package pizza.allan.frame;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** Validate the only writable Improv command before it reaches the selected peripheral. */
final class ImprovPacket {
    static void validate(byte[] bytes, int mtu) throws Exception {
        if (bytes.length < 6 || bytes.length > 101 || bytes.length > mtu - 3 || bytes[0] != 1
            || (bytes[1] & 255) != bytes.length - 3) throw new IllegalArgumentException();
        int sum = 0;
        for (int i = 0; i < bytes.length - 1; i++) sum = (sum + (bytes[i] & 255)) & 255;
        if (sum != (bytes[bytes.length - 1] & 255)) throw new IllegalArgumentException();
        int offset = 2;
        for (int field = 0; field < 2; field++) {
            if (offset >= bytes.length - 1) throw new IllegalArgumentException();
            int length = (bytes[offset++] & 255);
            if (length > (field == 0 ? 32 : 64) || (field == 0 && length == 0) || offset + length > bytes.length - 1)
                throw new IllegalArgumentException();
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, offset, length));
            offset += length;
        }
        if (offset != bytes.length - 1) throw new IllegalArgumentException();
    }
}

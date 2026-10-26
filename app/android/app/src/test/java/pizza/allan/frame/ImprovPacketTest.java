package pizza.allan.frame;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class ImprovPacketTest {
    private byte[] packet(String ssid, String password) {
        byte[] name = ssid.getBytes(StandardCharsets.UTF_8), pass = password.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(1); out.write(name.length + pass.length + 2);
        out.write(name.length); out.writeBytes(name); out.write(pass.length); out.writeBytes(pass);
        byte[] payload = out.toByteArray(); int sum = 0;
        for (byte b : payload) sum = (sum + Byte.toUnsignedInt(b)) & 255;
        out.write(sum); return out.toByteArray();
    }
    @Test public void acceptsMaximumAsciiAndUnicodeCredentialsInOneAttWrite() throws Exception {
        for (String name : new String[]{"a".repeat(32), "家".repeat(10) + "ab"}) {
            byte[] packet = packet(name, "é".repeat(32));
            assertEquals(101, packet.length); ImprovPacket.validate(packet, 104);
        }
        ImprovPacket.validate(packet("Open WiFi", ""), 185);
    }
    @Test public void rejectsOversizedMalformedAndNonProvisioningPackets() {
        byte[] badChecksum = packet("Wifi", "secret"); badChecksum[badChecksum.length - 1] ^= 1;
        byte[] wrongCommand = packet("Wifi", "secret"); wrongCommand[0] = 2;
        for (byte[] bytes : new byte[][]{new byte[0], packet("", "password"), packet("家".repeat(11), ""),
                packet("Wifi", "é".repeat(33)), badChecksum, wrongCommand, {1, 3, 1, (byte) 0xff, 0, 4}}) {
            assertThrows(Exception.class, () -> ImprovPacket.validate(bytes, 185));
        }
        assertThrows(Exception.class, () -> ImprovPacket.validate(packet("a".repeat(32), "b".repeat(64)), 103));
    }
}

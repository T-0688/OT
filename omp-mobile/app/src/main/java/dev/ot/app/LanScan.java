package dev.ot.app;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.Collections;
import java.util.List;

/**
 * 扫本机所在的 /24 网段，找开着 OT 端口的电脑。
 * 局域网直连比走隧道快一个量级。
 */
public class LanScan {
    public interface Callback {
        void onFound(String host);
    }

    public static void scan(int port, Callback callback) {
        Thread thread = new Thread(() -> {
            try {
                for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    List<InterfaceAddress> addrs = ni.getInterfaceAddresses();
                    for (InterfaceAddress ia : addrs) {
                        InetAddress addr = ia.getAddress();
                        if (!(addr instanceof Inet4Address)) continue;
                        if (!addr.isSiteLocalAddress()) continue;
                        int prefix = ia.getNetworkPrefixLength();
                        if (prefix < 24 || prefix > 30) continue;
                        byte[] base = addr.getAddress();
                        String head = (base[0] & 0xff) + "." + (base[1] & 0xff) + "." + (base[2] & 0xff) + ".";
                        for (int i = 1; i < 255; i++) {
                            if (i == (base[3] & 0xff)) continue;
                            String ip = head + i;
                            try {
                                Socket socket = new Socket();
                                socket.connect(new InetSocketAddress(ip, port), 220);
                                socket.close();
                                callback.onFound(ip);
                                return;
                            } catch (Exception ignored) {
                            }
                        }
                    }
                }
            } catch (Exception ignored) {
            }
        }, "ot-lan-scan");
        thread.setDaemon(true);
        thread.start();
    }
}

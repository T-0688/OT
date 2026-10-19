package dev.ot.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.security.SecureRandom;
import java.util.Random;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 极简 WebSocket 客户端（RFC6455），只实现 OT 需要的部分：
 * 文本帧、分片、ping/pong、close。客户端发帧必须掩码。
 */
public class OtWsClient {
    public interface Listener {
        void onOpen();

        void onText(String text);

        void onClosed(String reason);
    }

    private final Socket socket;
    private final InputStream in;
    private final OutputStream out;
    private final Listener listener;
    private final Random random = new Random();
    private volatile boolean closed;

    private OtWsClient(Socket socket, InputStream in, OutputStream out, Listener listener) {
        this.socket = socket;
        this.in = in;
        this.out = out;
        this.listener = listener;
        Thread thread = new Thread(this::readLoop, "ot-ws-reader");
        thread.setDaemon(true);
        thread.start();
    }

    public static OtWsClient connect(String url, Listener listener) throws IOException {
        URI uri = URI.create(url);
        boolean tls = "wss".equalsIgnoreCase(uri.getScheme());
        String host = uri.getHost();
        if (host == null) throw new IOException("bad url");
        int port = uri.getPort() > 0 ? uri.getPort() : (tls ? 443 : 80);
        String path = uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
        if (uri.getRawQuery() != null) path += "?" + uri.getRawQuery();

        Socket socket;
        if (tls) {
            // createSocket(host, port) 才会带上 SNI，Cloudflare 需要它选对证书
            SSLSocket ssl = (SSLSocket) SSLSocketFactory.getDefault().createSocket(host, port);
            ssl.setSoTimeout(15000);
            ssl.startHandshake();
            ssl.setSoTimeout(0);
            socket = ssl;
        } else {
            socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), 15000);
        }
        socket.setTcpNoDelay(true);
        socket.setSoTimeout(0);

        String key = randomKey();
        String hostHeader = host + (port != (tls ? 443 : 80) ? ":" + port : "");
        String request = "GET " + path + " HTTP/1.1\r\n"
                + "Host: " + hostHeader + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "User-Agent: OT-Android\r\n"
                + "\r\n";
        OutputStream out = socket.getOutputStream();
        out.write(request.getBytes("UTF-8"));
        out.flush();

        InputStream in = socket.getInputStream();
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) >= 0) {
            head.write(b);
            byte[] arr = head.toByteArray();
            int n = arr.length;
            if (n >= 4 && arr[n - 4] == '\r' && arr[n - 3] == '\n' && arr[n - 2] == '\r' && arr[n - 1] == '\n') break;
            if (n > 16384) throw new IOException("handshake too large");
        }
        String response = head.toString("UTF-8");
        if (!response.startsWith("HTTP/1.1 101") && !response.startsWith("HTTP/1.0 101")) {
            String first = response.split("\r\n", 2)[0];
            throw new IOException("handshake failed: " + first);
        }
        return new OtWsClient(socket, in, out, listener);
    }

    public boolean isClosed() {
        return closed;
    }

    public void ping() {
        try {
            sendFrame(0x9, new byte[0]);
        } catch (IOException ignored) {
        }
    }

    public void close() {
        if (closed) return;
        closed = true;
        try {
            sendFrame(0x8, new byte[0]);
        } catch (IOException ignored) {
        }
        try {
            socket.close();
        } catch (IOException ignored) {
        }
        try {
            listener.onClosed("closed");
        } catch (Exception ignored) {
        }
    }

    private void readLoop() {
        ByteArrayOutputStream fragments = new ByteArrayOutputStream();
        int fragmentOpcode = 0;
        try {
            while (!closed) {
                int b0 = in.read();
                int b1 = in.read();
                if (b0 < 0 || b1 < 0) break;
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0f;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7f;
                if (len == 126) {
                    len = ((in.read() & 0xff) << 8) | (in.read() & 0xff);
                } else if (len == 127) {
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | (in.read() & 0xff);
                }
                if (len > 8 * 1024 * 1024) throw new IOException("frame too large");
                byte[] mask = new byte[4];
                if (masked) readFully(mask);
                byte[] payload = new byte[(int) len];
                readFully(payload);
                if (masked) {
                    for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
                }
                if (opcode == 0x8) break; // close
                if (opcode == 0x9) { // ping -> pong
                    sendFrame(0xA, payload);
                    continue;
                }
                if (opcode == 0xA) continue; // pong
                if (opcode == 0x1 || opcode == 0x2 || opcode == 0x0) {
                    if (opcode != 0x0) {
                        fragments.reset();
                        fragmentOpcode = opcode;
                    }
                    fragments.write(payload);
                    if (fin) {
                        String text = fragments.toString("UTF-8");
                        fragments.reset();
                        if (fragmentOpcode == 0x1) {
                            try {
                                listener.onText(text);
                            } catch (Exception ignored) {
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (!closed) {
                closed = true;
                try {
                    socket.close();
                } catch (IOException ignored) {
                }
                try {
                    listener.onClosed("eof");
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void readFully(byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new IOException("eof");
            off += n;
        }
    }

    private void sendFrame(int opcode, byte[] payload) throws IOException {
        synchronized (out) {
            out.write(0x80 | opcode);
            int len = payload.length;
            if (len < 126) {
                out.write(0x80 | len);
            } else if (len < 65536) {
                out.write(0x80 | 126);
                out.write((len >> 8) & 0xff);
                out.write(len & 0xff);
            } else {
                out.write(0x80 | 127);
                for (int i = 7; i >= 0; i--) out.write((int) (((long) len) >> (8 * i)) & 0xff);
            }
            byte[] mask = new byte[4];
            random.nextBytes(mask);
            out.write(mask);
            byte[] data = payload;
            if (len > 0) {
                data = new byte[len];
                for (int i = 0; i < len; i++) data[i] = (byte) (payload[i] ^ mask[i % 4]);
            }
            out.write(data);
            out.flush();
        }
    }

    private static String randomKey() {
        byte[] raw = new byte[16];
        new SecureRandom().nextBytes(raw);
        return android.util.Base64.encodeToString(raw, android.util.Base64.NO_WRAP);
    }
}


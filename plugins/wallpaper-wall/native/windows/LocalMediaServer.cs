using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace WallpaperWall
{
    /// <summary>
    /// 只服务当前壁纸文件及同目录资源的回环 HTTP 服务。
    /// WebView2 对 file:// 视频导航会失败，因此统一走带 Range 的 loopback URL。
    /// </summary>
    public sealed class LocalMediaServer : IDisposable
    {
        private readonly string root;
        private readonly string entry;
        private readonly bool webEntry;
        private readonly TcpListener listener;
        private Thread acceptThread;
        private volatile bool running;

        public string BaseUrl { get; private set; }

        public LocalMediaServer(string entryPath, bool web)
        {
            entry = Path.GetFullPath(entryPath);
            root = Path.GetDirectoryName(entry) ?? Path.GetPathRoot(entry);
            webEntry = web;
            listener = new TcpListener(IPAddress.Loopback, 0);
        }

        public void Start()
        {
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            BaseUrl = "http://127.0.0.1:" + port;
            running = true;
            acceptThread = new Thread(AcceptLoop);
            acceptThread.IsBackground = true;
            acceptThread.Start();
        }

        private void AcceptLoop()
        {
            while (running)
            {
                TcpClient client = null;
                try { client = listener.AcceptTcpClient(); }
                catch { if (!running) return; continue; }
                ThreadPool.QueueUserWorkItem(delegate(object state) { Handle((TcpClient)state); }, client);
            }
        }

        private void Handle(TcpClient client)
        {
            using (client)
            using (NetworkStream stream = client.GetStream())
            {
                try
                {
                    StreamReader reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                    string requestLine = reader.ReadLine();
                    if (string.IsNullOrEmpty(requestLine)) return;
                    string[] parts = requestLine.Split(' ');
                    if (parts.Length < 2) return;
                    string method = parts[0];
                    string urlPath = parts[1];
                    Console.Error.WriteLine("[media] " + requestLine);
                    int query = urlPath.IndexOf('?');
                    if (query >= 0) urlPath = urlPath.Substring(0, query);
                    string rangeHeader = null;
                    string line;
                    while (!string.IsNullOrEmpty(line = reader.ReadLine()))
                    {
                        int colon = line.IndexOf(':');
                        if (colon > 0 && string.Equals(line.Substring(0, colon).Trim(), "Range", StringComparison.OrdinalIgnoreCase)) {
                            rangeHeader = line.Substring(colon + 1).Trim();
                        }
                    }
                    if (urlPath == "/player.html" && !webEntry)
                    {
                        string html = PlayerHtml(entry);
                        byte[] htmlBytes = Encoding.UTF8.GetBytes(html);
                        string htmlHeader = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + htmlBytes.Length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                        byte[] htmlHeaderBytes = Encoding.ASCII.GetBytes(htmlHeader);
                        stream.Write(htmlHeaderBytes, 0, htmlHeaderBytes.Length);
                        stream.Write(htmlBytes, 0, htmlBytes.Length);
                        stream.Flush();
                        return;
                    }
                    string filePath = ResolvePath(urlPath);
                    if (filePath == null || !File.Exists(filePath)) { WriteSimple(stream, 404, "Not Found", "missing file"); return; }
                    FileInfo info = new FileInfo(filePath);
                    long start = 0;
                    long end = info.Length - 1;
                    bool partial = false;
                    if (!string.IsNullOrEmpty(rangeHeader))
                    {
                        Match match = Regex.Match(rangeHeader, @"bytes=(\d*)-(\d*)");
                        if (!match.Success) { WriteSimple(stream, 416, "Range Not Satisfiable", "bad range"); return; }
                        string first = match.Groups[1].Value;
                        string second = match.Groups[2].Value;
                        if (first.Length == 0 && second.Length == 0) { WriteSimple(stream, 416, "Range Not Satisfiable", "bad range"); return; }
                        if (first.Length == 0)
                        {
                            long suffix = long.Parse(second);
                            start = Math.Max(0, info.Length - suffix);
                            end = info.Length - 1;
                        }
                        else
                        {
                            start = long.Parse(first);
                            end = second.Length == 0 ? info.Length - 1 : long.Parse(second);
                        }
                        if (start < 0 || start >= info.Length || end < start) { WriteSimple(stream, 416, "Range Not Satisfiable", "bad range"); return; }
                        if (end >= info.Length) end = info.Length - 1;
                        partial = true;
                    }
                    long length = end >= start ? end - start + 1 : 0;
                    string header = "HTTP/1.1 " + (partial ? "206 Partial Content" : "200 OK") + "\r\n" +
                        "Content-Type: " + MimeType(filePath) + "\r\n" +
                        "Content-Length: " + length + "\r\n" +
                        "Accept-Ranges: bytes\r\n" +
                        "Cache-Control: no-store\r\n" +
                        "Access-Control-Allow-Origin: *\r\n" +
                        "Connection: close\r\n" +
                        (partial ? "Content-Range: bytes " + start + "-" + end + "/" + info.Length + "\r\n" : "") +
                        "\r\n";
                    byte[] headerBytes = Encoding.ASCII.GetBytes(header);
                    stream.Write(headerBytes, 0, headerBytes.Length);
                    if (!string.Equals(method, "HEAD", StringComparison.OrdinalIgnoreCase) && length > 0)
                    {
                        using (FileStream file = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                        {
                            file.Seek(start, SeekOrigin.Begin);
                            byte[] buffer = new byte[64 * 1024];
                            long remaining = length;
                            while (remaining > 0 && running)
                            {
                                int read = file.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                                if (read <= 0) break;
                                stream.Write(buffer, 0, read);
                                remaining -= read;
                            }
                        }
                    }
                    stream.Flush();
                }
                catch
                {
                    // 客户端取消/关闭是媒体播放常态。
                }
            }
        }

        private static string PlayerHtml(string path)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            bool video = ext == ".mp4" || ext == ".m4v" || ext == ".webm" || ext == ".mov";
            string element = video
                ? "<video src=\"/media\" autoplay muted loop playsinline></video>"
                : "<img src=\"/media\" alt=\"\" />";
            return "<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}" + (video ? "video{width:100%;height:100%;object-fit:cover}video::-webkit-media-controls{display:none!important}" : "img{width:100%;height:100%;object-fit:cover}") + "</style></head><body>" + element + "</body></html>";
        }

        private string ResolvePath(string urlPath)
        {
            if (urlPath == "/" || urlPath == "/index.html" || urlPath == "/media")
            {
                if (urlPath == "/media" && webEntry) return null;
                return entry;
            }
            string relative;
            try { relative = Uri.UnescapeDataString(urlPath.TrimStart('/')); }
            catch { return null; }
            if (relative.IndexOf("..", StringComparison.Ordinal) >= 0) return null;
            string rootPrefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string candidate = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
            return candidate.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) ? candidate : null;
        }

        private static void WriteSimple(NetworkStream stream, int status, string reason, string body)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(body ?? "");
            string header = "HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + bytes.Length + "\r\nConnection: close\r\n\r\n";
            byte[] headerBytes = Encoding.ASCII.GetBytes(header);
            stream.Write(headerBytes, 0, headerBytes.Length);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        private static string MimeType(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".html": case ".htm": return "text/html; charset=utf-8";
                case ".js": case ".mjs": return "text/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".mp4": case ".m4v": return "video/mp4";
                case ".webm": return "video/webm";
                case ".gif": return "image/gif";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".webp": return "image/webp";
                case ".svg": return "image/svg+xml";
                default: return "application/octet-stream";
            }
        }

        public void Dispose()
        {
            running = false;
            try { listener.Stop(); } catch { }
        }
    }
}

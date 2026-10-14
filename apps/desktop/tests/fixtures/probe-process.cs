using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

// 可控的原生进程夹具只验证 MCP 取消/断开会杀死子进程；正常媒体另用真实 ffprobe。
class ProbeProcess {
    static void Main(string[] args) {
        string input = args[args.Length - 1];
        if (input.EndsWith("malformed.mp4")) { Console.Write("{bad json"); return; }
        if (input.EndsWith("failed.mp4")) { Console.Error.Write("fixture probe failure"); Environment.Exit(5); }
        File.WriteAllText(input + ".pid", Process.GetCurrentProcess().Id.ToString());
        Thread.Sleep(60000);
    }
}

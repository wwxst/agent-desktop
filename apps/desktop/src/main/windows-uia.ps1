$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$effectStarted = $false

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing
  # 输入与窗口截图只留在独立宿主 helper；模型不能提交脚本、坐标或原生命令。
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class AgentWindowsNative {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput mouse; [FieldOffset(0)] public KeyboardInput keyboard; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion value; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  static Input Key(ushort key, ushort scan, uint flags) {
    return new Input { type=1, value=new InputUnion { keyboard=new KeyboardInput { wVk=key, wScan=scan, dwFlags=flags } } };
  }
  static void Send(Input[] input) {
    if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Input))) != input.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows rejected keyboard input.");
  }
  public static void Chord(ushort[] keys) {
    Input[] input = new Input[keys.Length*2];
    for (int i=0;i<keys.Length;i++) { input[i]=Key(keys[i],0,0); input[input.Length-1-i]=Key(keys[i],0,2); }
    Send(input);
  }
  public static void Text(string text) {
    // 每批输入有界，避免大文档生成无限的本机输入结构。
    for (int offset=0;offset<text.Length;offset+=256) {
      int count=Math.Min(256,text.Length-offset); Input[] input=new Input[count*2];
      for(int i=0;i<count;i++) { input[i*2]=Key(0,text[offset+i],4); input[i*2+1]=Key(0,text[offset+i],6); }
      Send(input);
    }
  }
  public static void Screenshot(IntPtr window, string path) {
    Rect rect; if(!GetWindowRect(window,out rect)) throw new InvalidOperationException("Window rectangle is unavailable.");
    int width=rect.Right-rect.Left, height=rect.Bottom-rect.Top;
    if(width<=0 || height<=0 || width>8192 || height>8192 || (long)width*height>32000000) throw new InvalidOperationException("Window screenshot dimensions exceed the supported budget.");
    using(Bitmap bitmap=new Bitmap(width,height)) using(Graphics graphics=Graphics.FromImage(bitmap)) {
      IntPtr dc=graphics.GetHdc(); bool captured;
      try { captured=PrintWindow(window,dc,2); } finally { graphics.ReleaseHdc(dc); }
      if(!captured) throw new InvalidOperationException("Windows could not capture the selected window.");
      bitmap.Save(path,ImageFormat.Png);
    }
  }
}
'@
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json

  function Identity($element) {
    $current = $element.Current
    return @{ runtimeId = @($element.GetRuntimeId()); processId = $current.ProcessId; handle = [string]$current.NativeWindowHandle;
      name = $current.Name.Substring(0, [Math]::Min(512, $current.Name.Length)); automationId = $current.AutomationId;
      className = $current.ClassName; controlType = $current.ControlType.ProgrammaticName; enabled = $current.IsEnabled;
      offscreen = $current.IsOffscreen; password = $current.IsPassword; focusable = $current.IsKeyboardFocusable }
  }
  function Window($target) {
    $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$target.handle)
    if ($null -eq $element -or $element.Current.ProcessId -ne $target.processId -or $element.Current.ClassName -ne $target.className) {
      throw 'stale reference: window has changed or closed; refresh computer_window_list.'
    }
    return $element
  }
  function Elements($root, $maximum) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = New-Object 'System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]'
    $queue.Enqueue($root); $count = 0
    while ($queue.Count -gt 0 -and $count -lt $maximum) {
      $current = $queue.Dequeue(); $count++; Write-Output $current
      $child = $walker.GetFirstChild($current)
      while ($null -ne $child -and $queue.Count + $count -lt $maximum) {
        $queue.Enqueue($child); $child = $walker.GetNextSibling($child)
      }
    }
  }
  function Element($window, $identity) {
    $wanted = [string]::Join(',', $identity.runtimeId)
    foreach ($element in (Elements $window 512)) {
      if ([string]::Join(',', $element.GetRuntimeId()) -ne $wanted) { continue }
      $current = $element.Current
      if ($current.ProcessId -ne $identity.processId -or $current.ControlType.ProgrammaticName -ne $identity.controlType -or
        $current.AutomationId -ne $identity.automationId -or $current.ClassName -ne $identity.className -or
        $current.Name.Substring(0, [Math]::Min(512, $current.Name.Length)) -ne $identity.name) {
        throw 'stale reference: element properties changed; refresh computer_snapshot.'
      }
      if (-not $current.IsEnabled -or $current.IsOffscreen -or $current.IsPassword) { throw 'The selected element is unavailable, offscreen, disabled or protected.' }
      return $element
    }
    throw 'stale reference: element is no longer present; refresh computer_snapshot.'
  }
  function Focus($window, $element) {
    $handle = [IntPtr][long]$request.window.handle
    [void][AgentWindowsNative]::ShowWindow($handle, 9)
    if (-not [AgentWindowsNative]::SetForegroundWindow($handle)) { throw 'Windows did not permit foreground activation.' }
    $element.SetFocus()
    if ([AgentWindowsNative]::GetForegroundWindow() -ne $handle -or
      [string]::Join(',', [System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId()) -ne [string]::Join(',', $element.GetRuntimeId())) {
      throw 'Focus changed before input; refresh computer_snapshot.'
    }
  }

  if ($request.action -eq 'windows') {
    $windows = @(); $children = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($element in $children) {
      if ($windows.Count -ge 64) { break }
      if ($element.Current.NativeWindowHandle -eq 0 -or $element.Current.Name.Length -eq 0) { continue }
      $item = Identity $element
      $item.processName = (Get-Process -Id $element.Current.ProcessId -ErrorAction Stop).ProcessName
      $windows += $item
    }
    $data = @{ windows = $windows; truncated = $children.Count -gt 64 }
  } else {
    $window = Window $request.window
    if ($request.action -eq 'snapshot') {
      $elements = @(Elements $window 512); $items = @($elements | ForEach-Object { Identity $_ })
      $document = ''; $pattern = $null
      if ($window.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { $document = $pattern.DocumentRange.GetText(12000) }
      if ($document.Length -eq 0) {
        foreach ($element in $elements) {
          $pattern = $null
          if (-not $element.Current.IsPassword -and $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            $document += $pattern.DocumentRange.GetText([Math]::Max(0, 12000 - $document.Length))
            if ($document.Length -ge 12000) { break }
          }
        }
      }
      $data = @{ window = (Identity $window); elements = $items; text = $document; truncated = $elements.Count -ge 512 -or $document.Length -ge 12000 }
    } elseif ($request.action -eq 'screenshot') {
      $effectStarted = $true
      [AgentWindowsNative]::Screenshot([IntPtr][long]$request.window.handle, $request.path)
      $data = @{ path = $request.path }
    } else {
      $element = Element $window $request.element
      $pattern = $null
      if ($request.action -eq 'click') {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $effectStarted = $true; $pattern.Invoke() }
        elseif ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $effectStarted = $true; $pattern.Select() }
        elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $effectStarted = $true; $pattern.Toggle() }
        else { throw 'The element does not expose an actionable UI Automation pattern; coordinate guessing is disabled.' }
      } elseif ($request.action -eq 'type') {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
          if ($pattern.Current.IsReadOnly) { throw 'The selected element is read-only.' }
          $effectStarted = $true; $pattern.SetValue([string]$request.text)
          # UIA 文本提供程序可能把 LF 规范化为 CR/CRLF；仅规范化换行后核对真实值。
          $actualText = $pattern.Current.Value.Replace("`r`n", "`n").Replace("`r", "`n")
          $expectedText = ([string]$request.text).Replace("`r`n", "`n").Replace("`r", "`n")
          if ($actualText -ne $expectedText) { throw 'The UI did not confirm the requested value.' }
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern) -and $element.Current.IsKeyboardFocusable) {
          $effectStarted = $true; Focus $window $element
          [AgentWindowsNative]::Chord([UInt16[]]@(0x11, 0x41)); [AgentWindowsNative]::Text([string]$request.text)
        } else { throw 'The selected element does not expose an editable text surface.' }
      } elseif ($request.action -eq 'key') {
        $keys = @{ ENTER=13; ESC=27; TAB=9; SPACE=32; BACKSPACE=8; DELETE=46; LEFT=37; UP=38; RIGHT=39; DOWN=40; HOME=36; END=35; PAGEUP=33; PAGEDOWN=34; A=65; C=67; V=86; W=87; X=88; O=79; S=83; F4=115 }
        $parts = ([string]$request.key).ToUpperInvariant().Split('+'); $codes = @()
        foreach ($part in $parts) {
          if ($part -eq 'CTRL') { $codes += 17 } elseif ($part -eq 'SHIFT') { $codes += 16 } elseif ($part -eq 'ALT') { $codes += 18 }
          elseif ($keys.ContainsKey($part)) { $codes += $keys[$part] } else { throw 'Unsupported key; Windows and command-launch shortcuts are unavailable.' }
        }
        if ($codes.Count -eq 0 -or $codes.Count -gt 4) { throw 'Invalid keyboard chord.' }
        $effectStarted = $true
        if ($parts.Count -eq 1 -and $parts[0] -eq 'ESC' -and ($request.element.controlType -eq 'ControlType.Window' -or -not $element.Current.IsKeyboardFocusable)) {
          # 原生文件对话框的“取消”有时只是 Pane；只在所选窗口仍是前台且焦点属于同一进程时发 ESC。
          $handle = [IntPtr][long]$request.window.handle
          [void][AgentWindowsNative]::ShowWindow($handle, 9)
          if ((-not [AgentWindowsNative]::SetForegroundWindow($handle)) -or ([System.Windows.Automation.AutomationElement]::FocusedElement.Current.ProcessId -ne $request.window.processId)) {
            throw 'The selected application no longer owns the focused modal dialog.'
          }
        } else { Focus $window $element }
        [AgentWindowsNative]::Chord([UInt16[]]$codes)
      } elseif ($request.action -eq 'scroll') {
        if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern)) { throw 'The element does not expose UI Automation scrolling.' }
        $amount = if ($request.direction -eq 'up') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } else { [System.Windows.Automation.ScrollAmount]::LargeIncrement }
        $effectStarted = $true; $pattern.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $amount)
      } else { throw 'Unknown computer action.' }
      $data = @{ performed = $true; requiresSnapshot = $true }
    }
  }
  [Console]::WriteLine((@{ ok = $true; data = $data } | ConvertTo-Json -Depth 18 -Compress))
} catch {
  $kind = if ($effectStarted) { 'unknown-outcome' } else { 'permanent' }
  [Console]::WriteLine((@{ ok = $false; failureKind = $kind; message = $_.Exception.Message } | ConvertTo-Json -Depth 5 -Compress))
  exit 1
}

<#
  剪贴板图像助手（由 server.js 调用，无需手动运行）
    read  : 读取剪贴板 -> 输出 JSON
              {"kind":"files","paths":[...]}  剪贴板里是图片文件
              {"kind":"image","pngBase64":"..."} 剪贴板里是图像数据（截图等）
              {"kind":"text","text":"..."}    剪贴板里是文本
              {"kind":"empty"}                剪贴板为空
    write : 从标准输入读取 base64 PNG -> 写入剪贴板为图像 -> 输出 ok / fail
#>
param([Parameter(Mandatory = $true)][ValidateSet('read', 'write')][string]$Mode)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$imageExtensions = @('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')

if ($Mode -eq 'read') {
    $result = [ordered]@{ kind = 'empty' }
    try {
        # 1) 剪贴板里是文件（资源管理器里直接复制的图片）—— 优先，保留真实路径
        $paths = @()
        if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
            $paths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | Where-Object { $_ })
        }
        $images = @($paths | Where-Object { $imageExtensions -contains [System.IO.Path]::GetExtension($_).ToLower() })
        if ($images.Count -gt 0) {
            $result = [ordered]@{ kind = 'files'; paths = $images }
        }
        elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
            # 2) 截图 / 网页里"复制图片"：剪贴板里是图像数据
            $image = [System.Windows.Forms.Clipboard]::GetImage()
            $stream = New-Object System.IO.MemoryStream
            $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            $bytes = $stream.ToArray()
            $stream.Dispose()
            $image.Dispose()
            $result = [ordered]@{ kind = 'image'; pngBase64 = [Convert]::ToBase64String($bytes) }
        }
        elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
            $result = [ordered]@{ kind = 'text'; text = [System.Windows.Forms.Clipboard]::GetText() }
        }
        elseif ($paths.Count -gt 0) {
            # 复制的是非图片文件：把路径当文本给出
            $result = [ordered]@{ kind = 'text'; text = ($paths -join "`n") }
        }
    }
    catch {
        $result = [ordered]@{ kind = 'error'; message = $_.Exception.Message }
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 4))
    exit 0
}

if ($Mode -eq 'write') {
    try {
        $base64 = [Console]::In.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($base64)) { [Console]::Out.Write('fail:empty'); exit 0 }
        $bytes = [Convert]::FromBase64String($base64.Trim())
        $stream = New-Object System.IO.MemoryStream(, $bytes)
        $image = [System.Drawing.Image]::FromStream($stream)
        [System.Windows.Forms.Clipboard]::SetImage($image)
        $image.Dispose()
        $stream.Dispose()
        [Console]::Out.Write('ok')
    }
    catch {
        [Console]::Out.Write('fail:' + $_.Exception.Message)
    }
    exit 0
}

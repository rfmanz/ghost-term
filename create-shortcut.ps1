$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Ghost Term.lnk")
$shortcut.TargetPath = "$env:USERPROFILE\Desktop\ghost-term\launch.bat"
$shortcut.WorkingDirectory = "$env:USERPROFILE\Desktop\ghost-term"
$shortcut.IconLocation = "$env:USERPROFILE\Desktop\ghost-term\public\icon.ico,0"
$shortcut.Description = "Ghost Term"
$shortcut.Save()
Write-Output "Shortcut created"

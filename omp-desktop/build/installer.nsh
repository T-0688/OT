!macro preInit
  ; 默认安装到 D 盘（用户可通过安装界面改）
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\Programs\OT"
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\Programs\OT"
!macroend

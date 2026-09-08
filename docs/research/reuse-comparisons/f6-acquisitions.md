# F6 acquisition ledger

2026-09-08;140 GiB free before download. Owned `/private/tmp/cr-f6-eval.pIzVZ3`,
cap100 MiB; targeted text only, no binary/toolchain/media/packages installed.
Source pin WinSW v2.12.0 `eef5bade59fca0254e387ac73ed7625ba6aa7147` resolved public git.
Prefix `https://raw.githubusercontent.com/winsw/winsw/eef5bade59fca0254e387ac73ed7625ba6aa7147/`.
Paths: LICENSE.txt root; XmlServiceConfig.cs in src/WinSW.Core/Configuration/;
ProcessHelper.cs in src/WinSW.Core/Util/; WrapperService.cs in src/WinSW/;
ServiceDescriptorTests.cs in src/WinSW.Tests/; ProcessHelperTest.cs in
src/WinSW.Tests/Util/. tree.json from GitHub API tree recursively at same pin.
Curl eachfile cap2 MiB/20seconds, tree2 MiB/30seconds. No failed downloads.

| File | Bytes | SHA256 |
| --- | ---: | --- |
| LICENSE.txt | 1158 | 1cdf703c10a70e5973bf3acf2a5eeabe7746237155b92db2034aeae26fdf7802 |
| ProcessHelper.cs | 9780 | 5d8760401f99495d6f6a213f040cfaab4288317e6395ff335c72c36dbc4e2dcc |
| ProcessHelperTest.cs | 2601 | df2ae2baa31301b841160f3bb403f519713e9a775423ae9bf29f36a9657e94d5 |
| ServiceDescriptorTests.cs | 16522 | d5e0dc3d9314b8390fdd63b2b11bf8fef932d549b2f38635c1f97bb540eb1740 |
| WrapperService.cs | 15226 | 706c908eb4467d0d9963834e7099354f2c42652b9ff3a727a1710b45df025e46 |
| XmlServiceConfig.cs | 24610 | ec2906e01ef01656483f49efbf6fcd1c153857955fb759f6064764979f68b9e8 |
| tree.json | 39927 | 6ffa170dbdb012e12fb8b2cca6dea5210db8f43ce58b9a239f0795b9c70ba3b2 |

No upstream executable/test run (.NET absent). Four existing CR static tests passed;
xmllint wellformed checks passed with --nonet. No services or background processes.
Cleanup complete: lsof found no open handles; exact root removed, absence verified.
Peak allocation124 KiB removed. All files public and reacquirable from pins.

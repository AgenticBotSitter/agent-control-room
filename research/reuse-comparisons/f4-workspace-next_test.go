package gitworktree

import("context";"errors";"os";"os/exec";"path/filepath";"strings";"testing";"github.com/aoagents/agent-orchestrator/backend/internal/ports")

func TestControlRoomNextWorkspaceBoundaries(t *testing.T){
 root:=t.TempDir();repo:=filepath.Join(root,"repo");managed:=filepath.Join(root,"managed");hooks:=filepath.Join(root,"hooks")
 for _,p:=range []string{repo,managed,hooks}{if err:=os.MkdirAll(p,0700);err!=nil{t.Fatal(err)}}
 for _,k:=range []string{"GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES","GIT_CONFIG_PARAMETERS"}{if _,ok:=os.LookupEnv(k);ok{t.Fatal("ambient Git variable")}}
 for k,v:=range map[string]string{"GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null","GIT_CONFIG_COUNT":"3","GIT_CONFIG_KEY_0":"core.hooksPath","GIT_CONFIG_VALUE_0":hooks,"GIT_CONFIG_KEY_1":"init.templateDir","GIT_CONFIG_VALUE_1":hooks,"GIT_CONFIG_KEY_2":"credential.helper","GIT_CONFIG_VALUE_2":"","GIT_AUTHOR_NAME":"Synthetic","GIT_AUTHOR_EMAIL":"synthetic@example.invalid","GIT_COMMITTER_NAME":"Synthetic","GIT_COMMITTER_EMAIL":"synthetic@example.invalid"}{t.Setenv(k,v)}
 git:=func(dir string,args ...string)string{t.Helper();b,e:=exec.Command("git",append([]string{"-C",dir},args...)...).CombinedOutput();if e!=nil{t.Fatalf("git %v: %v %s",args,e,b)};return strings.TrimSpace(string(b))}
 write:=func(dir,body string){t.Helper();if e:=os.WriteFile(filepath.Join(dir,"shared.txt"),[]byte(body),0600);e!=nil{t.Fatal(e)}}
 git(repo,"init","-b","main");write(repo,"A\n");git(repo,"add",".");git(repo,"commit","-m","synthetic base");commit:=git(repo,"rev-parse","HEAD");if len(commit)!=40{t.Fatal("not immutable full revision")}
 makeWS:=func()*Workspace{t.Helper();w,e:=New(Options{ManagedRoot:managed,RepoResolver:StaticRepoResolver{"proj":repo}});if e!=nil{t.Fatal(e)};t.Cleanup(w.waitForDiscards);w.run=func(ctx context.Context,binary string,args ...string)([]byte,error){for _,a:=range args{if a=="fetch"||a=="clone"||a=="push"||a=="remote"{return nil,errors.New("prohibited remote operation")}};return runCommand(ctx,binary,args...)};return w}
 w:=makeWS();ctx:=context.Background();cfg:=ports.WorkspaceConfig{ProjectID:"proj",SessionID:"session",Branch:"feature/research",BaseBranch:"main",BaseRef:commit}
 info,e:=w.Restore(ctx,cfg);if e!=nil{t.Fatal(e)};if git(info.Path,"rev-parse","HEAD")!=commit{t.Fatal("seed revision mismatch")}
 // A new Workspace object represents loss of the previous in-memory object, not an OS crash.
 next:=makeWS();same,e:=next.Restore(ctx,cfg);if e!=nil||same.Path!=info.Path{t.Fatalf("duplicate restore %v",e)}
 t.Log("duplicate restore after object reconstruction reuses actual registered worktree")
 contender:=cfg;contender.SessionID="other";if _,e:=next.Restore(ctx,contender);!errors.Is(e,ErrBranchCheckedOutElsewhere){t.Fatalf("branch contention %v",e)}
 if e:=os.RemoveAll(info.Path);e!=nil{t.Fatal(e)} // owned synthetic directory only; leave registration stale
 if _,e:=next.StashUncommitted(ctx,info);!errors.Is(e,ports.ErrWorkspaceStale){t.Fatalf("stale stash %v",e)}
 info,e=next.Restore(ctx,cfg);if e!=nil{t.Fatal(e)};if git(info.Path,"rev-parse","HEAD")!=commit{t.Fatal("stale restore changed head")}
 t.Log("actual stale registration restored, prior missing path refused for stash")
 write(info.Path,"B\n");ref,e:=next.StashUncommitted(ctx,info);if e!=nil||ref==""{t.Fatalf("stash %v",e)}
 write(info.Path,"C\n");git(info.Path,"add","shared.txt");if e:=next.ApplyPreserved(ctx,info,ref);!errors.Is(e,ErrPreservedConflict){t.Fatalf("expected conflict %v",e)}
 b,e:=os.ReadFile(filepath.Join(info.Path,"shared.txt"));if e!=nil||!strings.Contains(string(b),"<<<<<<<"){t.Fatal("conflict markers missing")};if git(info.Path,"for-each-ref","--format=%(refname)",ref)!=ref{t.Fatal("conflict lost preservation ref")};if git(info.Path,"rev-parse","HEAD")!=commit{t.Fatal("conflict moved HEAD")}
 t.Log("real three-way conflict retains snapshot ref and markers without moving HEAD")
 // New separate owned branch shows BaseRef metadata is not a detached/head equality guard.
 second:=ports.WorkspaceConfig{ProjectID:"proj",SessionID:"second",Branch:"feature/second",BaseBranch:"main",BaseRef:commit}
 moved,e:=next.Restore(ctx,second);if e!=nil{t.Fatal(e)};write(moved.Path,"D\n");git(moved.Path,"add","shared.txt");git(moved.Path,"commit","-m","synthetic advance");advanced:=git(moved.Path,"rev-parse","HEAD")
 returned,e:=makeWS().Restore(ctx,second);if e!=nil{t.Fatal(e)};if returned.BaseRef!=commit||advanced==commit||git(returned.Path,"rev-parse","HEAD")!=advanced{t.Fatal("expected branch/head metadata distinction")}
 t.Log("negative CR fit: Restore accepts advanced attached branch while returning original BaseRef metadata")
 if git(repo,"remote")!=""{t.Fatal("unexpected remote")}
}

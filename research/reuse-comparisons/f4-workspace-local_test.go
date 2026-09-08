package gitworktree

// Research fixture: actual AO implementation, no origin/clone/push. Not an upstream test.
import (
 "context"
 "errors"
 "os"
 "os/exec"
 "path/filepath"
 "strings"
 "testing"
 "github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestControlRoomOwnedPreservation(t *testing.T) {
 for _, key:=range []string{"GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES","GIT_CONFIG_PARAMETERS"}{if _,exists:=os.LookupEnv(key);exists{t.Fatalf("ambient %s inherited",key)}}
 root:=t.TempDir(); repo:=filepath.Join(root,"repo"); managed:=filepath.Join(root,"managed"); hooks:=filepath.Join(root,"empty-hooks")
 for _, p:=range []string{repo,managed,hooks}{if err:=os.MkdirAll(p,0700);err!=nil{t.Fatal(err)}}
 for k,v:=range map[string]string{"GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null","GIT_CONFIG_COUNT":"3","GIT_CONFIG_KEY_0":"core.hooksPath","GIT_CONFIG_VALUE_0":hooks,"GIT_CONFIG_KEY_1":"init.templateDir","GIT_CONFIG_VALUE_1":hooks,"GIT_CONFIG_KEY_2":"credential.helper","GIT_CONFIG_VALUE_2":"","GIT_AUTHOR_NAME":"Synthetic Research","GIT_AUTHOR_EMAIL":"synthetic@example.invalid","GIT_COMMITTER_NAME":"Synthetic Research","GIT_COMMITTER_EMAIL":"synthetic@example.invalid"}{t.Setenv(k,v)}
 git:=func(dir string,args ...string)string{t.Helper(); c:=exec.Command("git",append([]string{"-C",dir},args...)...);out,err:=c.CombinedOutput();if err!=nil{t.Fatalf("git %v: %v %s",args,err,out)};return strings.TrimSpace(string(out))}
 write:=func(dir,name,body string){t.Helper();if err:=os.WriteFile(filepath.Join(dir,name),[]byte(body),0600);err!=nil{t.Fatal(err)}}
 git(repo,"init","-b","main");write(repo,"README","base\n");write(repo,".gitignore","ignored.txt\n");git(repo,"add",".");git(repo,"commit","-m","synthetic base")
 ws,err:=New(Options{ManagedRoot:managed,RepoResolver:StaticRepoResolver{"proj":repo}});if err!=nil{t.Fatal(err)}
 defer ws.waitForDiscards()
 // Guard commands routed through the private runner. Direct Stash/Apply calls were separately inspected.
 ws.run=func(ctx context.Context,binary string,args ...string)([]byte,error){for _,a:=range args{if a=="fetch"||a=="clone"||a=="push"||a=="remote"{return nil,errors.New("remote operation prohibited")}};return runCommand(ctx,binary,args...)}
 p:=filepath.Join(managed,"proj","sess");git(repo,"worktree","add","-b","feature/synthetic",p,"refs/heads/main")
 info:=ports.WorkspaceInfo{Path:p,ProjectID:"proj",SessionID:"sess",Branch:"feature/synthetic",BaseRef:"refs/heads/main"}
 write(p,"README","changed\n");write(p,"new.txt","new\n");write(p,"ignored.txt","disposable ignored\n")
 if err:=ws.Destroy(context.Background(),info);!errors.Is(err,ports.ErrWorkspaceDirty){t.Fatalf("dirty destroy: %v",err)}
 ref,err:=ws.StashUncommitted(context.Background(),info);if err!=nil||!strings.HasPrefix(ref,"refs/ao/preserved/"){t.Fatalf("preserve: %s %v",ref,err)}
 if err:=ws.ForceDestroy(context.Background(),info);err!=nil{t.Fatal(err)};ws.waitForDiscards()
 restored,err:=ws.Restore(context.Background(),ports.WorkspaceConfig{ProjectID:"proj",SessionID:"sess",Branch:"feature/synthetic",BaseBranch:"main",BaseRef:"refs/heads/main"});if err!=nil{t.Fatal(err)}
 if restored.Path!=p{t.Fatal("path changed")};if err:=ws.ApplyPreserved(context.Background(),restored,ref);err!=nil{t.Fatal(err)}
 for name,want:=range map[string]string{"README":"changed\n","new.txt":"new\n"}{b,err:=os.ReadFile(filepath.Join(p,name));if err!=nil||string(b)!=want{t.Fatalf("%s not restored: %v",name,err)}}
 if _,err:=os.Stat(filepath.Join(p,"ignored.txt"));!errors.Is(err,os.ErrNotExist){t.Fatal("ignored content returned")}
 if got:=git(repo,"for-each-ref","--format=%(refname)",ref);got!=""{t.Fatal("preservation ref retained after successful apply")}
 if got:=git(repo,"remote");got!=""{t.Fatal("unexpected remote")}
 t.Log("real Git: dirty refusal; tracked and untracked preservation; ignored exclusion; force removal; restore; apply; ref cleanup; no remotes")
}

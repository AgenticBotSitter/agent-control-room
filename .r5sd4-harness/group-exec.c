#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <fcntl.h>
int main(int argc,char **argv){if(argc<2||setpgid(0,0))return 70;char *r=getenv("R5SD_RECORD");if(r){int f=open(r,O_WRONLY|O_APPEND|O_CREAT,0600);if(f>=0){char b[64];int n=snprintf(b,sizeof(b),"{\"pid\":%d}\n",getpid());write(f,b,n);close(f);}}execvp(argv[1],argv+1);return 71;}

package main

import (
 "encoding/json"
 "os"
 "strings"
 "miniflux.app/v2/internal/reader/readability"
)

type Case struct {
 ID string `json:"id"`
 OriginalHTML string `json:"originalHTML"`
 InputByteLimit int `json:"inputByteLimit"`
}

func main() {
 var corpus struct { Cases []Case `json:"cases"` }
 if err := json.NewDecoder(os.Stdin).Decode(&corpus); err != nil { panic(err) }
 results := []map[string]interface{}{}
 for _, c := range corpus.Cases {
  if c.InputByteLimit > 0 && len([]byte(c.OriginalHTML)) > c.InputByteLimit {
   results = append(results, map[string]interface{}{"id":c.ID,"callerByteRejected":true,"called":false})
   continue
  }
  base, content, err := readability.ExtractContent(strings.NewReader(c.OriginalHTML))
  errorText := ""
  if err != nil { errorText = err.Error() }
  results = append(results,map[string]interface{}{"id":c.ID,"called":true,"baseURL":base,"html":content,"error":errorText})
 }
 if err := json.NewEncoder(os.Stdout).Encode(results); err != nil { panic(err) }
}

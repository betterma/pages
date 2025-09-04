// storage.js - 睡眠数据存储管理模块
const storage = (function() {
    // 私有方法
    async function request(endpoint, options = {}) {
      const token = auth.getToken();
      if (!token) throw new Error('未认证');
      
      const GITHUB_USERNAME = 'betterma';
      const GITHUB_REPO = 'mazha';
      
      const url = `https://api.github.com/repos/${GITHUB_USERNAME}/${GITHUB_REPO}/${endpoint}`;
      
      try {
        const response = await fetch(`${url}?t=${Date.now()}`, {
          ...options,
          headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json',
            ...(options.headers || {})
          }
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message || `GitHub API错误：${response.status}`);
        }
        
        return response.json();
      } catch (error) {
        console.error('GitHub存储错误:', error);
        throw error;
      }
    }
    
    // 公共接口
    return {
                    // 保存睡眠记录
       saveSleepRecord: async function(date, record, user = 'user1') {
         const filePath = `sleep/records/${date}.json`;
         const message = `${user} ${date} 睡眠记录已更新`;
         
         // 在记录中添加用户标识
         const recordWithUser = { ...record, user: user };
         
         try {
           // 检查文件是否存在
           const { sha } = await request(`contents/${filePath}`);
           // 更新现有文件
           return request(`contents/${filePath}`, {
             method: 'PUT',
             body: JSON.stringify({
               message,
               content: btoa(unescape(encodeURIComponent(JSON.stringify(recordWithUser, null, 2)))),
               sha
             })
           });
         } catch {
           // 创建新文件
           return request(`contents/${filePath}`, {
             method: 'PUT',
             body: JSON.stringify({
               message,
               content: btoa(unescape(encodeURIComponent(JSON.stringify(recordWithUser, null, 2))))
             })
           });
         }
       },
      
                    // 获取睡眠记录
       getSleepRecord: async function(date, user = 'user1') {
         const filePath = `sleep/records/${date}.json`;
         
         try {
           const file = await request(`contents/${filePath}`);
           const record = JSON.parse(decodeURIComponent(escape(atob(file.content))));
           // 如果记录属于指定用户，则返回
           if (record.user === user) {
             return record;
           }
           return null;
         } catch (error) {
           console.log(`没有找到${date}的睡眠记录`);
           return null;
         }
       },
      
                    // 获取所有睡眠记录
       getSleepRecords: async function(user = 'user1') {
         try {
           const data = await request('contents/sleep/records');
           const records = [];
           
           for (const item of data) {
             if (item.type === 'file' && item.name.endsWith('.json')) {
               try {
                 const record = await this.getSleepRecord(item.name.replace('.json', ''), user);
                 if (record) {
                   records.push(record);
                 }
               } catch (error) {
                 console.error(`读取记录失败: ${item.name}`, error);
               }
             }
           }
           
           return records.sort((a, b) => new Date(b.date) - new Date(a.date));
         } catch (error) {
           console.error(`获取${user}睡眠记录列表失败:`, error);
           return [];
         }
       },
       
       // 获取所有睡眠记录（不分用户）
       getAllSleepRecords: async function() {
         try {
           const data = await request('contents/sleep/records');
           const records = [];
           
           for (const item of data) {
             if (item.type === 'file' && item.name.endsWith('.json')) {
               try {
                 const filePath = `sleep/records/${item.name}`;
                 const file = await request(`contents/${filePath}`);
                 const record = JSON.parse(decodeURIComponent(escape(atob(file.content))));
                 records.push(record);
               } catch (error) {
                 console.error(`读取记录失败: ${item.name}`, error);
               }
             }
           }
           
           return records.sort((a, b) => new Date(b.date) - new Date(a.date));
         } catch (error) {
           console.error('获取所有睡眠记录失败:', error);
           return [];
         }
       },

                    // 删除睡眠记录
       deleteSleepRecord: async function(date, user = 'user1') {
         const filePath = `sleep/records/${date}.json`;
         try {
           // 先获取 sha
           const { sha } = await request(`contents/${filePath}`);
           return request(`contents/${filePath}`, {
             method: 'DELETE',
             body: JSON.stringify({
               message: `${user} ${date} 睡眠记录已删除`,
               sha
             })
           });
         } catch (error) {
           console.error(`删除${user}睡眠记录失败:`, error);
           throw error;
         }
       },

             // 获取睡眠统计数据
       getSleepStats: async function(user = 'user1') {
         try {
           const records = await this.getSleepRecords(user);
           if (records.length === 0) {
             return {
               totalDays: 0,
               avgSleepDuration: 0,
               avgSleepTime: 0,
               avgWakeTime: 0,
               avgBedTime: 0,
               totalSleepHours: 0
             };
           }

           let totalSleepHours = 0;
           let totalSleepTime = 0;
           let totalWakeTime = 0;
           let totalBedTime = 0;
           let bedTimeCount = 0;

           records.forEach(record => {
             if (record.sleepDuration) {
               totalSleepHours += record.sleepDuration;
             }
             if (record.sleepTimeHour) {
               totalSleepTime += record.sleepTimeHour;
             }
             if (record.wakeTimeHour) {
               totalWakeTime += record.wakeTimeHour;
             }
             if (record.bedTime) {
               const bedTimeHour = this.parseTimeToHour(record.bedTime);
               totalBedTime += bedTimeHour;
               bedTimeCount++;
             }
           });

           return {
             totalDays: records.length,
             avgSleepDuration: totalSleepHours / records.length,
             avgSleepTime: totalSleepTime / records.length,
             avgWakeTime: totalWakeTime / records.length,
             avgBedTime: bedTimeCount > 0 ? totalBedTime / bedTimeCount : 0,
             totalSleepHours: totalSleepHours
           };
         } catch (error) {
           console.error('获取睡眠统计失败:', error);
           return {
             totalDays: 0,
             avgSleepDuration: 0,
             avgSleepTime: 0,
             avgWakeTime: 0,
             avgBedTime: 0,
             totalSleepHours: 0
           };
         }
       },
       
       // 解析时间为小时数的辅助函数
       parseTimeToHour: function(timeStr) {
         if (!timeStr) return 0;
         const [hours, minutes] = timeStr.split(':').map(Number);
         return hours + minutes / 60;
       }
    };
  })();
